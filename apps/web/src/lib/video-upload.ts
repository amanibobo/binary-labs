import "server-only";
import type { ProtocolId, Sha256 } from "./ids";
import {
  abortStaged,
  discardStaged,
  joinStaged,
  keepStaged,
  receiveStagedPart,
  stagedPartUrl,
  startStaged,
  type Refused,
} from "./staged-upload";
import {
  RecordVideoRows,
  TOO_BIG,
  VIDEO_MAX_BYTES,
  VideoUploadId,
  type CompleteVideoRequest,
  type StartVideoRequest,
  type VideoReceipt,
  type VideoSession,
} from "./videos";

// A video goes straight to the store in parts (lib/staged-upload.ts); completing it joins and
// verifies the bytes on the server and only then records it on its page.

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
  const session = await startStaged(labId, req.type);
  return { session: { uploadId: VideoUploadId.parse(session.uploadId), storeId: session.storeId } };
}

export async function videoPartUrl(
  labId: string,
  session: VideoSession,
  part: { partNumber: number; size: number },
): Promise<{ url: string } | Refused> {
  return stagedPartUrl(labId, session, part, `/api/videos/uploads/${session.uploadId}/parts/${part.partNumber}`);
}

export const receiveVideoPart = receiveStagedPart;

const SHORT = { status: 400, error: "Some of the video didn't arrive. Add it again." } as const;

export async function completeVideoUpload(
  labId: string,
  uploadId: VideoUploadId,
  req: CompleteVideoRequest,
  record: RecordVideo,
): Promise<{ status: 200 | 201; receipt: VideoReceipt } | Refused> {
  const joined = await joinStaged(labId, uploadId, { ...req, maxBytes: VIDEO_MAX_BYTES });
  switch (joined.kind) {
    case "too_large":
      return { status: 413, error: TOO_BIG };
    case "short":
    case "size_mismatch":
      return SHORT;
    case "joined":
      break;
    default: {
      const _exhaustive: never = joined;
      return _exhaustive;
    }
  }
  await keepStaged(labId, uploadId, joined.sha256);
  // Throws on an unexpected database error, leaving the staged copy for a retry; recorded or
  // refused for good, the staged copy has done its job.
  const recorded = await recordVideo(labId, joined.sha256, joined.size, req, record);
  await discardStaged(labId, uploadId);
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
  await abortStaged(labId, session);
}
