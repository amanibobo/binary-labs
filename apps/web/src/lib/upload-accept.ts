import "server-only";
import type { Sha256 } from "./ids";
import { discardStaged, keepStaged, receiveStagedPut, startStagedPut, verifyStaged } from "./staged-upload";
import {
  parseUploadHeaders,
  RecordUploadRows,
  refusedKind,
  storedType,
  UPLOAD_MAX_BYTES,
  type CompleteUploadRequest,
  type StartUploadRequest,
  UploadId,
  type UploadPurpose,
  type UploadReceipt,
  type UploadSession,
} from "./uploads";
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

// The upload routes without their HTTP shell. A bench upload or a talk-through's recording
// goes straight to the store in one PUT (lib/staged-upload.ts), so a host's request-size cap
// (Vercel's 4.5 MB) never meets the file. Start checks the type and size and says where to
// PUT; complete checks what arrived and only then lets `record` say what it is. The lab
// comes from the session and every key is built from it, never from the request.

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

type Refused = { status: 400 | 403 | 404 | 408 | 409 | 411 | 413 | 415 | 422; error: string };
export type Accepted = { status: 200 | 201; receipt: UploadReceipt } | Refused;
export type AcceptedTalkThrough = { status: 200 | 201; receipt: TalkThroughReceipt } | Refused;

type Request = { headers: Headers; body: ReadableStream<Uint8Array> | null };

const TOO_LARGE = `Files can be up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`;

const LIMITS = {
  file: { refused: refusedKind, maxBytes: UPLOAD_MAX_BYTES, tooLarge: TOO_LARGE },
  "talk-through": { refused: refusedRecording, maxBytes: AUDIO_MAX_BYTES, tooLarge: TOO_LONG },
} as const satisfies Record<UploadPurpose, { refused: (mime: string) => string | null; maxBytes: number; tooLarge: string }>;

// The PUT's target when the store is a local folder; R2 hands out a presigned URL instead.
export const localPutRoute = (uploadId: string) => `/api/uploads/${uploadId}`;

export async function startUpload(labId: string, req: StartUploadRequest): Promise<{ status: 201; session: UploadSession } | Refused> {
  const limits = LIMITS[req.purpose];
  const contentType = storedType(req.type);
  const refused = limits.refused(contentType);
  if (refused !== null) return { status: 415, error: refused };
  if (req.size > limits.maxBytes) return { status: 413, error: limits.tooLarge };
  if (req.size === 0) return { status: 400, error: "That file is empty." };
  const put = await startStagedPut(labId, { size: req.size, contentType }, localPutRoute);
  return { status: 201, session: { ...put, uploadId: UploadId.parse(put.uploadId) } };
}

// Dev and tests: the PUT itself, when the store is a local folder. Bounded by the larger cap;
// complete holds each purpose to its own.
export async function receiveUploadBody(labId: string, uploadId: UploadId, request: Request): Promise<{ stored: true } | Refused> {
  return receiveStagedPut(labId, uploadId, request, Math.max(UPLOAD_MAX_BYTES, AUDIO_MAX_BYTES));
}

type Verified = { sha256: Sha256; size: number };

// Checks the staged bytes, keeps them at <lab_id>/files/<sha256>, records them, then drops the
// staged copy. A database error throws and leaves the staged copy, so complete can run again.
async function verifyAndRecord<R>(
  labId: string,
  uploadId: UploadId,
  claim: CompleteUploadRequest,
  limits: { maxBytes: number; tooLarge: string },
  record: (verified: Verified) => Promise<R | Refused>,
): Promise<R | Refused> {
  const verified = await verifyStaged(labId, uploadId, { size: claim.size, maxBytes: limits.maxBytes });
  switch (verified.kind) {
    case "too_large":
      return { status: 413, error: limits.tooLarge };
    case "short":
      return { status: 409, error: "The file never finished arriving. Add it again." };
    case "size_mismatch":
      return { status: 422, error: "The file that arrived isn't the size it was said to be. Add it again." };
    case "joined":
      break;
    default: {
      const _exhaustive: never = verified;
      return _exhaustive;
    }
  }
  if (claim.sha256 !== null && verified.sha256 !== claim.sha256) {
    await discardStaged(labId, uploadId);
    return { status: 422, error: "The file that arrived isn't the file that was sent. Add it again." };
  }
  await keepStaged(labId, uploadId, verified.sha256);
  const recorded = await record(verified);
  await discardStaged(labId, uploadId);
  return recorded;
}

export async function completeUpload(
  labId: string,
  uploadId: UploadId,
  request: { headers: Headers; claim: CompleteUploadRequest },
  record: RecordUpload,
): Promise<Accepted> {
  const meta = parseUploadHeaders(request.headers);
  if (meta === null) return { status: 400, error: "The upload is missing its name or date." };
  return verifyAndRecord(labId, uploadId, request.claim, LIMITS.file, async (stored) => {
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
    return { status: recorded.duplicate ? 200 : 201, receipt: { ...recorded, sha256: stored.sha256 } };
  });
}

// A talk-through's recording is stored the same way, with its own cap, and its record call
// also starts the talk-through.
export async function completeTalkThrough(
  labId: string,
  uploadId: UploadId,
  request: { headers: Headers; claim: CompleteUploadRequest },
  record: RecordTalkThrough,
): Promise<AcceptedTalkThrough> {
  const meta = parseTalkThroughHeaders(request.headers);
  if (meta === null) return { status: 400, error: "The recording is missing its name, date or page." };
  return verifyAndRecord(labId, uploadId, request.claim, LIMITS["talk-through"], async (stored) => {
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
