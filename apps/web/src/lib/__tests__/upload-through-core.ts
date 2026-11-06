import { createHash } from "node:crypto";
import { completeTalkThrough, completeUpload, receiveUploadBody, startUpload, type RecordTalkThrough, type RecordUpload } from "../upload-accept";
import { CompleteUploadRequest, type UploadPurpose } from "../uploads";

// What the browser does with the local store, through the routes' cores: start, PUT the bytes
// to our stand-in for R2, then complete. Each step's refusal comes back as it would to the page.

export type Sent = {
  bytes: Uint8Array<ArrayBuffer>;
  // The headers the page sends on complete: uploadHeaders(meta) or talkThroughHeaders(meta).
  meta: Record<string, string>;
  type?: string;
  // What the page claims, when a test wants it to lie.
  claim?: { size?: number; sha256?: string | null };
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function send<R>(
  purpose: UploadPurpose,
  labId: string,
  sent: Sent,
  complete: (uploadId: Parameters<typeof completeUpload>[1], claim: { size: number; sha256: string | null }) => Promise<R>,
) {
  const type = sent.type ?? (purpose === "file" ? "image/png" : "audio/webm");
  const size = sent.claim?.size ?? sent.bytes.byteLength;
  const started = await startUpload(labId, { purpose, size, type });
  if (!("session" in started)) return started;
  const { uploadId, headers } = started.session;
  const put = await receiveUploadBody(labId, uploadId, {
    headers: new Headers({ ...headers, "content-length": String(sent.bytes.byteLength) }),
    body: new Blob([sent.bytes]).stream(),
  });
  if (!("stored" in put)) return put;
  const claimed = sent.claim?.sha256 === undefined ? sha256(sent.bytes) : sent.claim.sha256;
  return complete(uploadId, { size, sha256: claimed });
}

export function sendUpload(labId: string, sent: Sent, record: RecordUpload) {
  return send("file", labId, sent, (uploadId, claim) =>
    completeUpload(labId, uploadId, { headers: new Headers(sent.meta), claim: CompleteUploadRequest.parse(claim) }, record),
  );
}

export function sendTalkThrough(labId: string, sent: Sent, record: RecordTalkThrough) {
  return send("talk-through", labId, sent, (uploadId, claim) =>
    completeTalkThrough(labId, uploadId, { headers: new Headers(sent.meta), claim: CompleteUploadRequest.parse(claim) }, record),
  );
}
