import { z } from "zod";
import { FileKind, IsoDate, LabelRow, LabelWire, type FileKind as FileKindT, type Label } from "./domain";
import { LocationId, Sha256 } from "./ids";

// Mirrors upload_max_bytes() in db/migrations/0008_uploads.sql; a db test checks they agree.
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

// The file goes up as the raw request body, so the rest rides in headers. A custom header
// also means a cross-site page can't send this request without a CORS preflight.
export const UPLOAD_HEADERS = {
  name: "x-upload-name",
  experiment: "x-upload-experiment",
  uploadedOn: "x-upload-date",
  modifiedAt: "x-upload-modified",
} as const;

export type UploadMeta = {
  name: string;
  experiment: string | null;
  // The uploader's own calendar day.
  uploadedOn: string;
  // The file's own modified time, epoch ms, when the browser knows it.
  modifiedAt: number | null;
};

const Encoded = z.string().transform((s, ctx) => {
  try {
    return decodeURIComponent(s);
  } catch {
    ctx.addIssue({ code: "custom", message: "not URI-encoded" });
    return z.NEVER;
  }
});

const UploadHeaders = z.object({
  name: Encoded.pipe(z.string().trim().min(1).max(200)),
  experiment: Encoded.pipe(z.string().trim().max(120))
    .optional()
    .transform((e) => (e === undefined || e === "" ? null : e)),
  uploadedOn: IsoDate,
  modifiedAt: z.coerce.number().int().positive().optional().transform((m) => m ?? null),
});

export function uploadHeaders(meta: UploadMeta): Record<string, string> {
  const headers: Record<string, string> = {
    [UPLOAD_HEADERS.name]: encodeURIComponent(meta.name),
    [UPLOAD_HEADERS.uploadedOn]: meta.uploadedOn,
  };
  if (meta.experiment !== null) headers[UPLOAD_HEADERS.experiment] = encodeURIComponent(meta.experiment);
  if (meta.modifiedAt !== null) headers[UPLOAD_HEADERS.modifiedAt] = String(meta.modifiedAt);
  return headers;
}

export function parseUploadHeaders(headers: Headers): UploadMeta | null {
  const read = (name: string) => headers.get(name) ?? undefined;
  const parsed = UploadHeaders.safeParse({
    name: read(UPLOAD_HEADERS.name),
    experiment: read(UPLOAD_HEADERS.experiment),
    uploadedOn: read(UPLOAD_HEADERS.uploadedOn),
    modifiedAt: read(UPLOAD_HEADERS.modifiedAt),
  });
  return parsed.success ? parsed.data : null;
}

// Videos and audio each belong to a page; everything else under the cap is welcome.
export function refusedKind(mime: string): string | null {
  if (mime.startsWith("video/")) return "Add a video from its protocol page.";
  if (mime.startsWith("audio/")) return "Audio goes in as a talk-through, from a protocol page.";
  return null;
}

export function uploadKey(labId: string, sha256: Sha256): string {
  return `${labId}/files/${sha256}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function localDay(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

// Phone cameras name every capture "image.jpg"; give each its own name, and the same for
// pasted screenshots, which arrive as "image.png".
export function capturedName(kind: "photo" | "screenshot", at: Date, type: string): string {
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "image/heic" ? "heic" : "jpg";
  const time = `${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
  return `${kind === "photo" ? "Photo" : "Screenshot"} ${localDay(at)} ${time}.${ext}`;
}

// Served inline only when the browser renders it as an image, a PDF or plain text; anything
// else (HTML, SVG) could run script on our origin, so it downloads.
const INLINE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
  "text/csv",
  // Talk-through recordings play in the page.
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/flac",
  // Procedure videos play on their protocol page.
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export type Delivery = { contentType: string; disposition: string };

export function deliveryFor(mime: string | null, name: string): Delivery {
  const inline = mime !== null && INLINE_TYPES.has(mime);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return {
    contentType: inline ? mime : "application/octet-stream",
    disposition: `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
}

export const UploadReceipt = z.object({ locationId: LocationId, sha256: Sha256, duplicate: z.boolean() });
export type UploadReceipt = z.infer<typeof UploadReceipt>;

export const RecordUploadRows = z
  .tuple([z.object({ location_id: LocationId, duplicate: z.boolean() })])
  .transform(([r]) => ({ locationId: r.location_id, duplicate: r.duplicate }));

// How far an upload has got, once its bytes are with us.
export type UploadProgress =
  | { kind: "reading" }
  | { kind: "labeling"; fileKind: FileKindT; hasPreview: boolean; sha256: Sha256 }
  | { kind: "labeled"; fileKind: FileKindT; hasPreview: boolean; sha256: Sha256; label: Label }
  | { kind: "failed"; message: string };

export type UploadRow = {
  locationId: LocationId;
  name: string;
  experiment: string | null;
  uploadedAt: string;
  progress: UploadProgress;
};

const IndexState = z.enum(["pending", "indexed", "failed"]);

export const MyUploadsRows = z.array(
  z
    .object({
      location_id: LocationId,
      sha256: Sha256.nullable(),
      name: z.string(),
      experiment: z.string().nullable(),
      uploaded_at: z.string(),
      index_state: IndexState,
      index_error: z.string().nullable(),
      file_kind: FileKind.nullable(),
      has_preview: z.boolean(),
      label: LabelRow.nullable(),
    })
    .transform((r): UploadRow => ({
      locationId: r.location_id,
      name: r.name,
      experiment: r.experiment,
      uploadedAt: r.uploaded_at,
      progress: progressOf(r),
    })),
);

function progressOf(r: {
  sha256: Sha256 | null;
  index_state: z.infer<typeof IndexState>;
  index_error: string | null;
  file_kind: FileKindT | null;
  has_preview: boolean;
  label: Label | null;
}): UploadProgress {
  if (r.index_state === "failed") return { kind: "failed", message: r.index_error ?? "We couldn't read this file." };
  if (r.index_state === "pending" || r.sha256 === null || r.file_kind === null) return { kind: "reading" };
  const done = { fileKind: r.file_kind, hasPreview: r.has_preview, sha256: r.sha256 };
  return r.label === null ? { kind: "labeling", ...done } : { kind: "labeled", ...done, label: r.label };
}

const ProgressWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reading") }),
  z.object({ kind: z.literal("labeling"), fileKind: FileKind, hasPreview: z.boolean(), sha256: Sha256 }),
  z.object({ kind: z.literal("labeled"), fileKind: FileKind, hasPreview: z.boolean(), sha256: Sha256, label: LabelWire }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
]) satisfies z.ZodType<UploadProgress>;

export const UploadRowsWire = z.array(
  z.object({
    locationId: LocationId,
    name: z.string(),
    experiment: z.string().nullable(),
    uploadedAt: z.string(),
    progress: ProgressWire,
  }) satisfies z.ZodType<UploadRow>,
);

export function isSettled(progress: UploadProgress): boolean {
  return progress.kind === "labeled" || progress.kind === "failed";
}
