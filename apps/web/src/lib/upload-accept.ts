import "server-only";
import { logError } from "./log";
import { putFile } from "./object-store";
import { receiveUpload, type Received } from "./upload-receive";
import { parseUploadHeaders, RecordUploadRows, refusedKind, UPLOAD_MAX_BYTES, uploadKey, type UploadReceipt } from "./uploads";
import {
  AUDIO_MAX_BYTES,
  parseTalkThroughHeaders,
  recordTalkThroughArgs,
  RecordTalkThroughRows,
  refusedRecording,
  TOO_LONG,
  type RecordTalkThroughArgs,
  type TalkThroughReceipt,
} from "./talk-throughs";

// record_upload's arguments, by name, as supabase-js sends them.
export type RecordUploadArgs = {
  p_lab_id: string;
  p_sha256: string;
  p_size: number;
  p_name: string;
  p_experiment: string | null;
  p_uploaded_on: string;
  p_modified_at: string | null;
};

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

// Calls the recording function as the signed-in member, so RLS and the membership check apply.
export type RecordUpload = (args: RecordUploadArgs) => Promise<RpcResult>;
export type RecordTalkThrough = (args: RecordTalkThroughArgs) => Promise<RpcResult>;

type Refused = { status: 400 | 403 | 404 | 408 | 409 | 411 | 413 | 415; error: string };
export type Accepted = { status: 200 | 201; receipt: UploadReceipt } | Refused;
export type AcceptedTalkThrough = { status: 200 | 201; receipt: TalkThroughReceipt } | Refused;

type Request = { headers: Headers; body: ReadableStream<Uint8Array> | null };
type Stored = Extract<Received, { kind: "received" }>;

const TOO_LARGE = `Files can be up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`;

// The upload route without its HTTP shell: check the type and size, stream the body to a temp
// file while hashing it, put it in the store under the lab's prefix, then let `record` say
// what it is. The lab comes from the session, never from the request.
async function receiveAndStore<R>(
  request: Request,
  labId: string,
  limits: { refused: (mime: string) => string | null; maxBytes: number; tooLarge: string },
  record: (stored: Stored) => Promise<R | Refused>,
): Promise<R | Refused> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const refused = limits.refused(contentType);
  if (refused !== null) return { status: 415, error: refused };
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (!Number.isSafeInteger(declared) || declared < 0) return { status: 411, error: "The upload needs a Content-Length." };

  const received = await receiveUpload(request.body, { maxBytes: limits.maxBytes, declaredBytes: declared });
  switch (received.kind) {
    case "too_large":
      return { status: 413, error: limits.tooLarge };
    case "truncated":
      return { status: 408, error: "The upload was cut off. Try again." };
    case "empty":
      return { status: 400, error: "That file is empty." };
    case "received":
      break;
    default: {
      const _exhaustive: never = received;
      return _exhaustive;
    }
  }
  try {
    await putFile(uploadKey(labId, received.sha256), received, contentType);
    return await record(received);
  } finally {
    await received.cleanup();
  }
}

// tagBatch records which files were sent together; a failure there doesn't fail the upload.
export async function acceptUpload(
  request: Request,
  labId: string,
  record: RecordUpload,
  tagBatch?: (locationId: string, batch: string) => Promise<void>,
): Promise<Accepted> {
  const meta = parseUploadHeaders(request.headers);
  if (meta === null) return { status: 400, error: "The upload is missing its name or date." };
  return receiveAndStore(request, labId, { refused: refusedKind, maxBytes: UPLOAD_MAX_BYTES, tooLarge: TOO_LARGE }, async (stored) => {
    const { data, error } = await record({
      p_lab_id: labId,
      p_sha256: stored.sha256,
      p_size: stored.size,
      p_name: meta.name,
      p_experiment: meta.experiment,
      p_uploaded_on: meta.uploadedOn,
      p_modified_at: meta.modifiedAt === null ? null : new Date(meta.modifiedAt).toISOString(),
    });
    if (error?.code === "BL201") return { status: 413, error: TOO_LARGE };
    if (error?.code === "22023") return { status: 400, error: error.message };
    if (error !== null) throw new Error(`record_upload: ${error.message} (${error.code ?? "no code"})`);
    const recorded = RecordUploadRows.parse(data);
    if (!recorded.duplicate && meta.batch !== undefined && meta.batch !== null && tagBatch !== undefined) {
      await tagBatch(recorded.locationId, meta.batch).catch((e: unknown) => logError("uploads.batch_failed", { labId, error: e }));
    }
    return { status: recorded.duplicate ? 200 : 201, receipt: { ...recorded, sha256: stored.sha256 } };
  });
}

// A talk-through rides the same route: the same store and key, its own cap, and a record
// call that also starts the talk-through.
export async function acceptTalkThrough(request: Request, labId: string, record: RecordTalkThrough): Promise<AcceptedTalkThrough> {
  const meta = parseTalkThroughHeaders(request.headers);
  if (meta === null) return { status: 400, error: "The recording is missing its name, date or page." };
  const limits = { refused: refusedRecording, maxBytes: AUDIO_MAX_BYTES, tooLarge: TOO_LONG };
  return receiveAndStore(request, labId, limits, async (stored) => {
    const { data, error } = await record(recordTalkThroughArgs(labId, stored.sha256, stored.size, meta));
    if (error !== null) {
      switch (error.code) {
        case "BL201":
          return { status: 413, error: TOO_LONG };
        case "BL102":
          return { status: 409, error: "This page is archived, so it can't take new steps." };
        case "BL103":
          return { status: 404, error: "This page isn't in your lab." };
        case "22023":
          return { status: 400, error: error.message };
        default:
          throw new Error(`record_talk_through: ${error.message} (${error.code ?? "no code"})`);
      }
    }
    const recorded = RecordTalkThroughRows.parse(data);
    return { status: recorded.duplicate ? 200 : 201, receipt: { ...recorded, sha256: stored.sha256 } };
  });
}

