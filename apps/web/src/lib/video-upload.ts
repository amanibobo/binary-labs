import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  discardStaging,
  copyObject,
  objectSize,
  partDestination,
  putLocalPart,
  readObject,
} from "./object-store";
import { receiveUpload } from "./upload-receive";
import { uploadKey } from "./uploads";
import { Sha256, type ProtocolId } from "./ids";
import {
  partCount,
  partSpan,
  RecordVideoRows,
  TOO_BIG,
  VIDEO_MAX_BYTES,
  VIDEO_PART_BYTES,
  VideoUploadId,
  type CompleteVideoRequest,
  type StartVideoRequest,
  type VideoReceipt,
  type VideoSession,
} from "./videos";

// A video goes straight to the store in parts, under a staging key in the viewer's lab, so
// our server never carries it in one request. Completing it is where the server takes over
// again: it reads the joined object back, checks its size and computes its sha256 itself,
// moves it to <lab_id>/files/<sha256>, and only then records it. Every key is built here from
// the session's lab, never from the request.

type Refused = { status: 400 | 404 | 408 | 409 | 411 | 413; error: string };

export type PageCheck = (protocolId: ProtocolId) => Promise<"open" | "archived" | "missing">;

// record_video's arguments, by name, as supabase-js sends them.
export type RecordVideoArgs = {
  p_lab_id: string;
  p_sha256: string;
  p_size: number;
  p_name: string;
  p_uploaded_on: string;
  p_modified_at: string | null;
  p_protocol_id: string;
};
type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
export type RecordVideo = (args: RecordVideoArgs) => Promise<RpcResult>;

export function stagingKey(labId: string, uploadId: VideoUploadId): string {
  return `${labId}/uploads/${uploadId}`;
}

const pageRefusal = {
  archived: { status: 409, error: "This page is archived, so it can't take a video." },
  missing: { status: 404, error: "This page isn't in your lab." },
} as const satisfies Record<string, Refused>;

export async function startVideoUpload(
  labId: string,
  req: StartVideoRequest,
  checkPage: PageCheck,
): Promise<{ session: VideoSession } | Refused> {
  if (req.size > VIDEO_MAX_BYTES) return { status: 413, error: TOO_BIG };
  const page = await checkPage(req.protocolId);
  if (page !== "open") return pageRefusal[page];
  const uploadId = VideoUploadId.parse(randomUUID());
  const storeId = await createMultipart(stagingKey(labId, uploadId), req.type, uploadId);
  return { session: { uploadId, storeId } };
}

function partSize(size: number, partNumber: number): number | null {
  if (partNumber > partCount(size)) return null;
  const span = partSpan(size, partNumber);
  return span.end - span.start;
}

// Where part n goes: a presigned R2 URL that only takes this part at its exact size, or, with
// the local store, our own route.
export async function videoPartUrl(
  labId: string,
  session: VideoSession,
  { partNumber, size }: { partNumber: number; size: number },
): Promise<{ url: string } | Refused> {
  const bytes = partSize(size, partNumber);
  if (bytes === null) return { status: 400, error: "That part is past the end of the video." };
  const destination = await partDestination(stagingKey(labId, session.uploadId), session.storeId, partNumber, bytes);
  switch (destination.kind) {
    case "presigned":
      return { url: destination.url };
    case "ours":
      return { url: `/api/videos/uploads/${session.uploadId}/parts/${partNumber}` };
    default: {
      const _exhaustive: never = destination;
      return _exhaustive;
    }
  }
}

type Request = { headers: Headers; body: ReadableStream<Uint8Array> | null };

// The local store's stand-in for R2's part upload. A part is at most one part's size.
export async function receiveVideoPart(
  labId: string,
  uploadId: VideoUploadId,
  partNumber: number,
  request: Request,
): Promise<{ etag: string } | Refused> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (!Number.isSafeInteger(declared) || declared < 0) return { status: 411, error: "A part needs a Content-Length." };
  const received = await receiveUpload(request.body, { maxBytes: VIDEO_PART_BYTES, declaredBytes: declared });
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

const SHORT = { status: 400, error: "Some of the video didn't arrive. Add it again." } as const;

export async function completeVideoUpload(
  labId: string,
  uploadId: VideoUploadId,
  req: CompleteVideoRequest,
  record: RecordVideo,
): Promise<{ status: 200 | 201; receipt: VideoReceipt } | Refused> {
  if (req.size > VIDEO_MAX_BYTES) return { status: 413, error: TOO_BIG };
  const expected = partCount(req.size);
  if (req.parts.length !== expected || req.parts.some((p, i) => p.partNumber !== i + 1)) return SHORT;
  const staged = stagingKey(labId, uploadId);
  // Every step until the record can run again: a complete retried after a lost answer or a
  // failure finds the joined object (R2 won't complete an upload twice) or joins the parts again.
  if ((await objectSize(staged)) !== req.size) {
    const joined = await completeMultipart(staged, req.storeId, req.parts, { partBytes: VIDEO_PART_BYTES, size: req.size });
    if (joined === "incomplete") return SHORT;
  }
  const size = await objectSize(staged);
  if (size === null) return SHORT;
  if (size !== req.size || size > VIDEO_MAX_BYTES) {
    await discardStaging(staged);
    return size > VIDEO_MAX_BYTES ? { status: 413, error: TOO_BIG } : SHORT;
  }
  const hashed = await sha256Of(await readObject(staged));
  if (hashed.size !== size) throw new Error(`read ${hashed.size} of ${size} bytes of ${staged}`);
  await copyObject(staged, uploadKey(labId, hashed.sha256));

  // Throws on an unexpected database error, leaving the staged copy for a retry; recorded or
  // refused for good, the staged copy has done its job.
  const recorded = await recordVideo(labId, hashed.sha256, size, req, record);
  await discardStaging(staged);
  return recorded;
}

async function recordVideo(
  labId: string,
  sha256: Sha256,
  size: number,
  req: CompleteVideoRequest,
  record: RecordVideo,
): Promise<{ status: 200 | 201; receipt: VideoReceipt } | Refused> {
  const { data, error } = await record({
    p_lab_id: labId,
    p_sha256: sha256,
    p_size: size,
    p_name: req.name,
    p_uploaded_on: req.uploadedOn,
    p_modified_at: req.modifiedAt === null ? null : new Date(req.modifiedAt).toISOString(),
    p_protocol_id: req.protocolId,
  });
  if (error !== null) {
    switch (error.code) {
      case "BL201":
        return { status: 413, error: TOO_BIG };
      case "BL102":
        return pageRefusal.archived;
      case "BL103":
        return pageRefusal.missing;
      case "22023":
        return { status: 400, error: error.message };
      default:
        throw new Error(`record_video: ${error.message} (${error.code ?? "no code"})`);
    }
  }
  const recorded = RecordVideoRows.parse(data);
  return { status: recorded.duplicate ? 200 : 201, receipt: { ...recorded, sha256 } };
}

export async function abortVideoUpload(labId: string, session: VideoSession): Promise<void> {
  await abortMultipart(stagingKey(labId, session.uploadId), session.storeId);
}
