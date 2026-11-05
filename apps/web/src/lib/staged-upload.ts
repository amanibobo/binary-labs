import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  abortMultipart,
  completeMultipart,
  copyObject,
  createMultipart,
  discardStaging,
  objectSize,
  partDestination,
  putLocalPart,
  readObject,
  type PartRef,
} from "./object-store";
import { PART_BYTES, partCount, partSpan } from "./parts";
import { receiveUpload } from "./upload-receive";
import { uploadKey } from "./uploads";
import { Sha256 } from "./ids";

// A file sent straight to the store in parts, under a staging key in the sender's lab, so our
// server never carries it in one request. Joining it is where the server takes over again: it
// reads the joined object back, checks its size and computes its sha256 itself. Only then may
// it be kept at <lab_id>/files/<sha256>. Videos and instrument files both come this way; every
// key is built here from the caller's lab, never from the request.

export type Refused = { status: 400 | 404 | 408 | 409 | 411 | 413 | 422; error: string };

export type StagedSession = { uploadId: string; storeId: string };

export function stagingKey(labId: string, uploadId: string): string {
  return `${labId}/uploads/${uploadId}`;
}

export async function startStaged(labId: string, contentType: string): Promise<StagedSession> {
  const uploadId = randomUUID();
  const storeId = await createMultipart(stagingKey(labId, uploadId), contentType, uploadId);
  return { uploadId, storeId };
}

function partSize(size: number, partNumber: number): number | null {
  if (partNumber > partCount(size)) return null;
  const span = partSpan(size, partNumber);
  return span.end - span.start;
}

// Where part n goes: a presigned R2 URL that only takes this part at its exact size, or, with
// the local store, our own route.
export async function stagedPartUrl(
  labId: string,
  session: StagedSession,
  { partNumber, size }: { partNumber: number; size: number },
  ourRoute: string,
): Promise<{ url: string } | Refused> {
  const bytes = partSize(size, partNumber);
  if (bytes === null) return { status: 400, error: "That part is past the end of the file." };
  const destination = await partDestination(stagingKey(labId, session.uploadId), session.storeId, partNumber, bytes);
  switch (destination.kind) {
    case "presigned":
      return { url: destination.url };
    case "ours":
      return { url: ourRoute };
    default: {
      const _exhaustive: never = destination;
      return _exhaustive;
    }
  }
}

type PartRequest = { headers: Headers; body: ReadableStream<Uint8Array> | null };

// The local store's stand-in for R2's part upload. A part is at most one part's size.
export async function receiveStagedPart(
  labId: string,
  uploadId: string,
  partNumber: number,
  request: PartRequest,
): Promise<{ etag: string } | Refused> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (!Number.isSafeInteger(declared) || declared < 0) return { status: 411, error: "A part needs a Content-Length." };
  const received = await receiveUpload(request.body, { maxBytes: PART_BYTES, declaredBytes: declared });
  switch (received.kind) {
    case "too_large":
      return { status: 413, error: "That part is larger than a part can be." };
    case "truncated":
      return { status: 408, error: "The part was cut off. Try again." };
    case "empty":
      return { status: 400, error: "That part is empty." };
    case "received":
      break;
    default: {
      const _exhaustive: never = received;
      return _exhaustive;
    }
  }
  try {
    await putLocalPart(stagingKey(labId, uploadId), partNumber, received);
  } finally {
    await received.cleanup();
  }
  return { etag: `"${received.sha256}"` };
}

async function sha256Of(chunks: AsyncIterable<Uint8Array>): Promise<{ sha256: Sha256; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of chunks) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { sha256: Sha256.parse(hash.digest("hex")), size };
}

export type Joined = { kind: "joined"; sha256: Sha256; size: number };

// Joins the parts and hashes what the store holds. Every step can run again: a join retried
// after a lost answer or a failure finds the joined object (R2 won't complete an upload twice)
// or joins the parts again. "short" means some of the file never arrived; "too_large" and
// "size_mismatch" have already dropped the staged copy.
export async function joinStaged(
  labId: string,
  uploadId: string,
  req: { storeId: string; parts: readonly PartRef[]; size: number; maxBytes: number },
): Promise<Joined | { kind: "short" } | { kind: "too_large" } | { kind: "size_mismatch" }> {
  if (req.size > req.maxBytes) return { kind: "too_large" };
  const expected = partCount(req.size);
  if (req.parts.length !== expected || req.parts.some((p, i) => p.partNumber !== i + 1)) return { kind: "short" };
  const staged = stagingKey(labId, uploadId);
  if ((await objectSize(staged)) !== req.size) {
    const joined = await completeMultipart(staged, req.storeId, req.parts, { partBytes: PART_BYTES, size: req.size });
    if (joined === "incomplete") return { kind: "short" };
  }
  const size = await objectSize(staged);
  if (size === null) return { kind: "short" };
  if (size > req.maxBytes) {
    await discardStaging(staged);
    return { kind: "too_large" };
  }
  if (size !== req.size) {
    await discardStaging(staged);
    return { kind: "size_mismatch" };
  }
  const hashed = await sha256Of(await readObject(staged));
  if (hashed.size !== size) throw new Error(`read ${hashed.size} of ${size} bytes of ${staged}`);
  return { kind: "joined", sha256: hashed.sha256, size };
}

// Keeps the verified bytes where the lab's files live. Same bytes, same key, so a repeat is harmless.
export async function keepStaged(labId: string, uploadId: string, sha256: Sha256): Promise<void> {
  await copyObject(stagingKey(labId, uploadId), uploadKey(labId, sha256));
}

export async function discardStaged(labId: string, uploadId: string): Promise<void> {
  await discardStaging(stagingKey(labId, uploadId));
}

export async function abortStaged(labId: string, session: StagedSession): Promise<void> {
  await abortMultipart(stagingKey(labId, session.uploadId), session.storeId);
}
