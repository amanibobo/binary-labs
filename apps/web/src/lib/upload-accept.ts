import "server-only";
import { putFile } from "./object-store";
import { receiveUpload } from "./upload-receive";
import { parseUploadHeaders, RecordUploadRows, refusedKind, UPLOAD_MAX_BYTES, uploadKey, type UploadReceipt } from "./uploads";

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

// Calls record_upload as the signed-in member, so RLS and the membership check apply.
export type RecordUpload = (args: RecordUploadArgs) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;

export type Accepted = { status: 200 | 201; receipt: UploadReceipt } | { status: 400 | 408 | 411 | 413 | 415; error: string };

const TOO_LARGE = `Files can be up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`;

// The upload route without its HTTP shell: check the headers, stream the body to a temp file
// while hashing it, put it in the store under the lab's prefix, then record it. The lab comes
// from the session, never from the request.
export async function acceptUpload(
  request: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  labId: string,
  record: RecordUpload,
): Promise<Accepted> {
  const meta = parseUploadHeaders(request.headers);
  if (meta === null) return { status: 400, error: "The upload is missing its name or date." };
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const refused = refusedKind(contentType);
  if (refused !== null) return { status: 415, error: refused };
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (!Number.isSafeInteger(declared) || declared < 0) return { status: 411, error: "The upload needs a Content-Length." };

  const received = await receiveUpload(request.body, { maxBytes: UPLOAD_MAX_BYTES, declaredBytes: declared });
  switch (received.kind) {
    case "too_large":
      return { status: 413, error: TOO_LARGE };
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
    const { data, error } = await record({
      p_lab_id: labId,
      p_sha256: received.sha256,
      p_size: received.size,
      p_name: meta.name,
      p_experiment: meta.experiment,
      p_uploaded_on: meta.uploadedOn,
      p_modified_at: meta.modifiedAt === null ? null : new Date(meta.modifiedAt).toISOString(),
    });
    if (error?.code === "BL201") return { status: 413, error: TOO_LARGE };
    if (error?.code === "22023") return { status: 400, error: error.message };
    if (error !== null) throw new Error(`record_upload: ${error.message} (${error.code ?? "no code"})`);
    const recorded = RecordUploadRows.parse(data);
    return { status: recorded.duplicate ? 200 : 201, receipt: { ...recorded, sha256: received.sha256 } };
  } finally {
    await received.cleanup();
  }
}
