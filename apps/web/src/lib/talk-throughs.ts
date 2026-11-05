import { z } from "zod";
import { IsoDate } from "./domain";
import { LocationId, ProtocolId, ProtocolVersionId, Sha256, TalkThroughId, UserId } from "./ids";
import { ProtocolKind, protocolFailure, type ProtocolFailure } from "./protocols";

// A talk-through: someone records themselves explaining a procedure, the worker transcribes
// it and drafts numbered steps, and a person reviews the draft before it becomes a version.

// Mirrors audio_max_bytes() in db/migrations/0009_talk_throughs.sql; a db test checks they agree.
export const AUDIO_MAX_BYTES = 100 * 1024 * 1024;

// Long enough for a long procedure told slowly; one procedure usually takes 2 to 15 minutes.
// At RECORDING_BITS that's about 15 MB, which goes up in under 30 s on 5 Mbps bench Wi-Fi,
// and its transcript (about 4,500 words) is a comfortable draft for the model.
export const RECORDING_MAX_MS = 30 * 60 * 1000;
export const RECORDING_BITS = 64_000;
// Shown before the cap stops the recording by itself.
export const RECORDING_WARN_MS = RECORDING_MAX_MS - 2 * 60 * 1000;

export type RecordingFormat = { mimeType: string; extension: "weba" | "m4a" };

// Opus in WebM where the browser has it (Chrome, Firefox, Android); AAC in MP4 on Safari.
// WebM sniffs as video, so it's named .weba and the worker knows it's sound.
const FORMATS: readonly RecordingFormat[] = [
  { mimeType: "audio/webm;codecs=opus", extension: "weba" },
  { mimeType: "audio/mp4;codecs=mp4a.40.2", extension: "m4a" },
  { mimeType: "audio/mp4", extension: "m4a" },
  { mimeType: "audio/webm", extension: "weba" },
];

export function recordingFormat(isTypeSupported: (type: string) => boolean): RecordingFormat | null {
  return FORMATS.find((f) => isTypeSupported(f.mimeType)) ?? null;
}

// The type the upload route and the worker see, without codec parameters.
export function baseType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

const pad = (n: number) => String(n).padStart(2, "0");

export function recordingName(at: Date, extension: RecordingFormat["extension"]): string {
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `Talk-through ${day} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}.${extension}`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return hours > 0 ? `${hours}:${rest}` : rest;
}

// What a recording is for: a new page of some kind, or the next version of a page, saved on
// top of the version that was on screen while recording.
export type TalkThroughTarget =
  | { kind: "new"; pageKind: ProtocolKind }
  | { kind: "page"; protocolId: ProtocolId; baseVersionId: ProtocolVersionId };

export type TalkThroughMeta = {
  name: string;
  uploadedOn: string;
  modifiedAt: number | null;
  target: TalkThroughTarget;
  durationMs: number | null;
};

// The audio goes up through /api/uploads like any upload; these headers say it's a talk-through.
export const TALK_THROUGH_HEADERS = {
  purpose: "x-upload-purpose",
  pageKind: "x-talk-through-kind",
  page: "x-talk-through-page",
  base: "x-talk-through-base",
  duration: "x-talk-through-duration",
} as const;

export const TALK_THROUGH_PURPOSE = "talk-through";

export function talkThroughHeaders(meta: TalkThroughMeta): Record<string, string> {
  const headers: Record<string, string> = {
    [TALK_THROUGH_HEADERS.purpose]: TALK_THROUGH_PURPOSE,
    "x-upload-name": encodeURIComponent(meta.name),
    "x-upload-date": meta.uploadedOn,
  };
  if (meta.modifiedAt !== null) headers["x-upload-modified"] = String(meta.modifiedAt);
  if (meta.durationMs !== null) headers[TALK_THROUGH_HEADERS.duration] = String(Math.round(meta.durationMs));
  switch (meta.target.kind) {
    case "new":
      headers[TALK_THROUGH_HEADERS.pageKind] = meta.target.pageKind;
      break;
    case "page":
      headers[TALK_THROUGH_HEADERS.page] = meta.target.protocolId;
      headers[TALK_THROUGH_HEADERS.base] = meta.target.baseVersionId;
      break;
    default: {
      const _exhaustive: never = meta.target;
      return _exhaustive;
    }
  }
  return headers;
}

export function isTalkThroughUpload(headers: Headers): boolean {
  return headers.get(TALK_THROUGH_HEADERS.purpose) === TALK_THROUGH_PURPOSE;
}

const Encoded = z.string().transform((s, ctx) => {
  try {
    return decodeURIComponent(s);
  } catch {
    ctx.addIssue({ code: "custom", message: "not URI-encoded" });
    return z.NEVER;
  }
});

const TalkThroughHeaders = z
  .object({
    name: Encoded.pipe(z.string().trim().min(1).max(200)),
    uploadedOn: IsoDate,
    modifiedAt: z.coerce.number().int().positive().optional(),
    durationMs: z.coerce.number().int().positive().max(2_147_483_647).optional(),
    pageKind: ProtocolKind.optional(),
    page: ProtocolId.optional(),
    base: ProtocolVersionId.optional(),
  })
  .transform((h, ctx): TalkThroughMeta => {
    const page = h.page !== undefined && h.base !== undefined ? { protocolId: h.page, baseVersionId: h.base } : null;
    if ((h.page === undefined) !== (h.base === undefined) || (page === null) === (h.pageKind === undefined)) {
      ctx.addIssue({ code: "custom", message: "a talk-through is for a new page or for one version of a page" });
      return z.NEVER;
    }
    return {
      name: h.name,
      uploadedOn: h.uploadedOn,
      modifiedAt: h.modifiedAt ?? null,
      durationMs: h.durationMs ?? null,
      target: page !== null ? { kind: "page", ...page } : { kind: "new", pageKind: h.pageKind ?? "protocol" },
    };
  });

export function parseTalkThroughHeaders(headers: Headers): TalkThroughMeta | null {
  const read = (name: string) => headers.get(name) ?? undefined;
  const parsed = TalkThroughHeaders.safeParse({
    name: read("x-upload-name"),
    uploadedOn: read("x-upload-date"),
    modifiedAt: read("x-upload-modified"),
    durationMs: read(TALK_THROUGH_HEADERS.duration),
    pageKind: read(TALK_THROUGH_HEADERS.pageKind),
    page: read(TALK_THROUGH_HEADERS.page),
    base: read(TALK_THROUGH_HEADERS.base),
  });
  return parsed.success ? parsed.data : null;
}

// Sound only: a talk-through is something said.
export function refusedRecording(mime: string): string | null {
  return baseType(mime).startsWith("audio/") ? null : "A talk-through has to be a sound recording.";
}

export const TOO_LONG = `Recordings can be up to ${AUDIO_MAX_BYTES / 1024 / 1024} MB.`;

// record_talk_through's arguments, by name, as supabase-js sends them.
export function recordTalkThroughArgs(labId: string, sha256: Sha256, size: number, meta: TalkThroughMeta) {
  return {
    p_lab_id: labId,
    p_sha256: sha256,
    p_size: size,
    p_name: meta.name,
    p_uploaded_on: meta.uploadedOn,
    p_modified_at: meta.modifiedAt === null ? null : new Date(meta.modifiedAt).toISOString(),
    p_kind: meta.target.kind === "new" ? meta.target.pageKind : null,
    p_protocol_id: meta.target.kind === "page" ? meta.target.protocolId : null,
    p_base_version_id: meta.target.kind === "page" ? meta.target.baseVersionId : null,
    p_duration_ms: meta.durationMs,
  };
}
export type RecordTalkThroughArgs = ReturnType<typeof recordTalkThroughArgs>;

export const TalkThroughReceipt = z.object({
  talkThroughId: TalkThroughId,
  locationId: LocationId,
  sha256: Sha256,
  duplicate: z.boolean(),
});
export type TalkThroughReceipt = z.infer<typeof TalkThroughReceipt>;

export const RecordTalkThroughRows = z
  .tuple([z.object({ talk_through_id: TalkThroughId, location_id: LocationId, duplicate: z.boolean() })])
  .transform(([r]) => ({ talkThroughId: r.talk_through_id, locationId: r.location_id, duplicate: r.duplicate }));

// How far a talk-through has got. The draft never applies itself; "ready" waits for a person.
export type TalkThroughStatus =
  | { kind: "transcribing" }
  | { kind: "drafting"; transcript: string }
  | { kind: "ready"; transcript: string; title: string; body: string }
  // No draft will come (no model, no speech, nothing like steps); the transcript is there to start from.
  | { kind: "no_draft"; transcript: string; message: string }
  | { kind: "failed"; stage: "transcribe" | "draft"; transcript: string | null; message: string };

export type TalkThroughPage = { protocolId: ProtocolId; title: string; baseVersionId: ProtocolVersionId; baseVersion: number };

export type TalkThrough = {
  id: TalkThroughId;
  kind: ProtocolKind;
  // The page it was recorded for; null for a new page.
  page: TalkThroughPage | null;
  recordedBy: UserId | null;
  recordedAt: string;
  durationMs: number | null;
  audio: { locationId: LocationId; name: string };
  status: TalkThroughStatus;
  used: { protocolId: ProtocolId; version: number } | null;
};

// What the editor starts from: the drafted steps, or the transcript when asked for or when no
// steps came. Null while there's nothing to start from, or once the steps are on a page.
export function editorStart(
  tt: TalkThrough,
  from: "steps" | "transcript",
): { title: string; body: string; from: "steps" | "transcript" } | null {
  const s = tt.status;
  if (tt.used !== null || s.kind === "transcribing") return null;
  // An existing page keeps its own title; the drafted one names a new page.
  if (from === "steps" && s.kind === "ready") return { title: tt.page?.title ?? s.title, body: s.body, from: "steps" };
  if (s.transcript === null || s.transcript.trim() === "") return null;
  return { title: tt.page?.title ?? "", body: s.transcript, from: "transcript" };
}

export function isSettled(status: TalkThroughStatus): boolean {
  return status.kind === "ready" || status.kind === "no_draft" || status.kind === "failed";
}

const IndexState = z.enum(["pending", "indexed", "failed"]);
const DraftState = z.enum(["waiting", "ready", "failed", "unavailable"]);
const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

const TalkThroughRow = z.object({
  id: TalkThroughId,
  kind: ProtocolKind,
  protocol_id: ProtocolId.nullable(),
  protocol_title: z.string().nullable(),
  base_version_id: ProtocolVersionId.nullable(),
  base_version: z.number().int().positive().nullable(),
  recorded_by: UserId.nullable(),
  recorded_at: Timestamp,
  duration_ms: z.number().int().positive().nullable(),
  location_id: LocationId,
  sha256: Sha256.nullable(),
  name: z.string(),
  index_state: IndexState,
  index_error: z.string().nullable(),
  transcript: z.string().nullable(),
  draft: DraftState,
  draft_title: z.string().nullable(),
  draft_body: z.string().nullable(),
  draft_error: z.string().nullable(),
  used_protocol_id: ProtocolId.nullable(),
  used_version: z.number().int().positive().nullable(),
});
type TalkThroughRow = z.infer<typeof TalkThroughRow>;

export function statusOf(r: Pick<TalkThroughRow, "index_state" | "index_error" | "sha256" | "transcript" | "draft" | "draft_title" | "draft_body" | "draft_error">): TalkThroughStatus {
  if (r.index_state === "failed") {
    return { kind: "failed", stage: "transcribe", transcript: null, message: r.index_error ?? "We couldn't transcribe this recording." };
  }
  if (r.index_state === "pending" || r.sha256 === null) return { kind: "transcribing" };
  const transcript = r.transcript ?? "";
  switch (r.draft) {
    case "waiting":
      return { kind: "drafting", transcript };
    case "ready":
      return r.draft_title !== null && r.draft_body !== null
        ? { kind: "ready", transcript, title: r.draft_title, body: r.draft_body }
        : { kind: "drafting", transcript };
    case "failed":
      return { kind: "failed", stage: "draft", transcript, message: r.draft_error ?? "We couldn't draft steps. Try again." };
    case "unavailable":
      return { kind: "no_draft", transcript, message: r.draft_error ?? "We couldn't draft steps from this recording." };
    default: {
      const _exhaustive: never = r.draft;
      return _exhaustive;
    }
  }
}

function fromRow(r: TalkThroughRow): TalkThrough {
  const page =
    r.protocol_id !== null && r.base_version_id !== null && r.base_version !== null
      ? { protocolId: r.protocol_id, title: r.protocol_title ?? "", baseVersionId: r.base_version_id, baseVersion: r.base_version }
      : null;
  return {
    id: r.id,
    kind: r.kind,
    page,
    recordedBy: r.recorded_by,
    recordedAt: r.recorded_at,
    durationMs: r.duration_ms,
    audio: { locationId: r.location_id, name: r.name },
    status: statusOf(r),
    used: r.used_protocol_id !== null && r.used_version !== null ? { protocolId: r.used_protocol_id, version: r.used_version } : null,
  };
}

// talk_through() answers no row for one that isn't there or isn't this lab's.
export const TalkThroughRows = z
  .array(TalkThroughRow)
  .max(1)
  .transform((rows) => (rows[0] === undefined ? null : fromRow(rows[0])));

const StatusWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transcribing") }),
  z.object({ kind: z.literal("drafting"), transcript: z.string() }),
  z.object({ kind: z.literal("ready"), transcript: z.string(), title: z.string(), body: z.string() }),
  z.object({ kind: z.literal("no_draft"), transcript: z.string(), message: z.string() }),
  z.object({ kind: z.literal("failed"), stage: z.enum(["transcribe", "draft"]), transcript: z.string().nullable(), message: z.string() }),
]) satisfies z.ZodType<TalkThroughStatus>;

export const TalkThroughWire = z.object({
  id: TalkThroughId,
  kind: ProtocolKind,
  page: z
    .object({ protocolId: ProtocolId, title: z.string(), baseVersionId: ProtocolVersionId, baseVersion: z.number().int().positive() })
    .nullable(),
  recordedBy: UserId.nullable(),
  recordedAt: Timestamp,
  durationMs: z.number().int().positive().nullable(),
  audio: z.object({ locationId: LocationId, name: z.string() }),
  status: StatusWire,
  used: z.object({ protocolId: ProtocolId, version: z.number().int().positive() }).nullable(),
}) satisfies z.ZodType<TalkThrough>;

// open_talk_throughs() rows: recordings waiting for someone to use them.
export type OpenTalkThrough = {
  id: TalkThroughId;
  kind: ProtocolKind;
  recordedBy: UserId | null;
  recordedAt: string;
  durationMs: number | null;
  progress: "transcribing" | "drafting" | "ready" | "needs_you";
  title: string | null;
};

export const OpenTalkThroughRows = z.array(
  z
    .object({
      id: TalkThroughId,
      kind: ProtocolKind,
      recorded_by: UserId.nullable(),
      recorded_at: Timestamp,
      duration_ms: z.number().int().positive().nullable(),
      index_state: IndexState,
      draft: DraftState,
      draft_title: z.string().nullable(),
    })
    .transform(
      (r): OpenTalkThrough => ({
        id: r.id,
        kind: r.kind,
        recordedBy: r.recorded_by,
        recordedAt: r.recorded_at,
        durationMs: r.duration_ms,
        progress:
          r.index_state === "pending"
            ? "transcribing"
            : r.index_state === "failed" || r.draft === "failed" || r.draft === "unavailable"
              ? "needs_you"
              : r.draft === "waiting"
                ? "drafting"
                : "ready",
        title: r.draft_title,
      }),
    ),
);

export const ApplyTalkThroughRequest = z.object({
  kind: ProtocolKind,
  baseVersionId: ProtocolVersionId.nullable(),
  title: z.string().trim().min(1, "Give the page a title.").max(200, "Keep the title under 200 characters."),
  body: z.string().max(200_000, "This page is too long to save."),
  note: z
    .string()
    .trim()
    .max(300, "Keep the note under 300 characters.")
    .transform((s) => (s === "" ? null : s))
    .nullable(),
});
export type ApplyTalkThroughRequest = z.input<typeof ApplyTalkThroughRequest>;

export function applyTalkThroughArgs(id: TalkThroughId, req: z.output<typeof ApplyTalkThroughRequest>) {
  return { p_id: id, p_kind: req.kind, p_base_version_id: req.baseVersionId, p_title: req.title, p_body: req.body, p_note: req.note };
}

// use_talk_through raises the protocol codes plus its own.
export function applyFailure(error: { code?: string; message: string }): ProtocolFailure {
  switch (error.code) {
    case "BL105":
      return { kind: "error", status: 409, message: "These steps are already on a page." };
    case "BL106":
      return { kind: "error", status: 409, message: "The recording is still being transcribed." };
    default:
      return protocolFailure(error);
  }
}

export function talkThroughHref(id: TalkThroughId): string {
  return `/talk-throughs/${id}`;
}

export function recordHref(target: { protocolId: ProtocolId } | { pageKind: ProtocolKind }): string {
  return "protocolId" in target ? `/talk-throughs/new?page=${target.protocolId}` : `/talk-throughs/new?kind=${target.pageKind}`;
}
