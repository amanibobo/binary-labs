import { z } from "zod";
import { IsoDate, SourceKind } from "./domain";
import { LocationId, ProtocolId, Sha256 } from "./ids";

// Mirrors video_max_bytes() in db/migrations/0010_videos.sql; a db test checks they agree.
// About 3 to 5 minutes from a phone camera at 1080p.
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

// Every part but the last is this size, as R2 requires. At 5 Mbps one part takes about 13 s,
// which is the most a dropped connection costs.
export const VIDEO_PART_BYTES = 8 * 1024 * 1024;

// What a browser plays and we serve inline; a phone records one of these.
export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export const VideoType = z.enum(VIDEO_TYPES);
export type VideoType = z.infer<typeof VideoType>;

export const TOO_BIG = "Videos can be up to 500 MB, about 3 to 5 minutes from a phone. Trim it in Photos first.";

export function refusedVideo(file: { type: string; size: number }): string | null {
  if (!VideoType.safeParse(file.type).success) return "That isn't a video we can play here. Try an MP4, MOV or WebM.";
  if (file.size > VIDEO_MAX_BYTES) return TOO_BIG;
  if (file.size === 0) return "That video is empty.";
  return null;
}

export function partCount(size: number): number {
  return Math.max(1, Math.ceil(size / VIDEO_PART_BYTES));
}

// Part n (from 1) of a file: its first byte and the byte after its last.
export function partSpan(size: number, n: number): { start: number; end: number } {
  const start = (n - 1) * VIDEO_PART_BYTES;
  return { start, end: Math.min(size, start + VIDEO_PART_BYTES) };
}

// One upload in progress: our id, which names its staging key under the viewer's lab, and the
// store's own multipart id (R2's UploadId; locally the same as ours).
export const VideoUploadId = z.uuid().brand<"VideoUploadId">();
export type VideoUploadId = z.infer<typeof VideoUploadId>;

export const VideoSession = z.object({ uploadId: VideoUploadId, storeId: z.string().min(1).max(1024) });
export type VideoSession = z.infer<typeof VideoSession>;

const Name = z.string().trim().min(1).max(200);

export const StartVideoRequest = z.object({
  protocolId: ProtocolId,
  name: Name,
  size: z.number().int().positive(),
  type: VideoType,
});
export type StartVideoRequest = z.infer<typeof StartVideoRequest>;

// Bounded by the cap, so a session can't be stretched past 500 MB of staged parts.
export const PartTargetRequest = z.object({ storeId: VideoSession.shape.storeId, size: z.number().int().positive().max(VIDEO_MAX_BYTES) });

// Where to PUT one part: our own route in dev, a presigned R2 URL in the pilot.
export const PartTarget = z.object({ url: z.string().min(1) });

export const UploadedPart = z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) });
export type UploadedPart = z.infer<typeof UploadedPart>;

export const CompleteVideoRequest = StartVideoRequest.extend({
  storeId: VideoSession.shape.storeId,
  parts: z.array(UploadedPart).min(1).max(10_000),
  uploadedOn: IsoDate,
  modifiedAt: z.number().int().positive().nullable(),
});
export type CompleteVideoRequest = z.infer<typeof CompleteVideoRequest>;

export const VideoReceipt = z.object({ locationId: LocationId, sha256: Sha256, duplicate: z.boolean(), linked: z.boolean() });
export type VideoReceipt = z.infer<typeof VideoReceipt>;

export const RecordVideoRows = z
  .tuple([z.object({ location_id: LocationId, duplicate: z.boolean(), linked: z.boolean() })])
  .transform(([r]) => ({ locationId: r.location_id, duplicate: r.duplicate, linked: r.linked }));

// What's been heard in a video on a page.
export type VideoTranscript =
  | { kind: "waiting" }
  | { kind: "ready"; text: string }
  // Retry may help: the transcriber couldn't be reached.
  | { kind: "failed"; message: string }
  // It won't: no sound, too long, or no ffmpeg on the worker.
  | { kind: "unavailable"; message: string };

export type ProtocolVideo =
  // The bytes are with us; the worker hasn't checked them yet.
  | { state: "preparing"; locationId: LocationId; name: string; size: number }
  | { state: "failed"; locationId: LocationId; name: string; message: string }
  | {
      state: "ready";
      locationId: LocationId;
      sha256: Sha256;
      name: string;
      path: string;
      sourceKind: SourceKind;
      mime: string;
      size: number;
      hasPoster: boolean;
      transcript: VideoTranscript;
    };

const TranscriptState = z.enum(["waiting", "ready", "failed", "unavailable"]);

function transcriptOf(state: z.infer<typeof TranscriptState>, error: string | null, text: string | null): VideoTranscript {
  switch (state) {
    case "waiting":
      return { kind: "waiting" };
    case "ready":
      return { kind: "ready", text: text ?? "" };
    case "failed":
      return { kind: "failed", message: error ?? "We couldn't transcribe this video." };
    case "unavailable":
      return { kind: "unavailable", message: error ?? "This video can't be transcribed." };
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

const ProtocolVideoRow = z.discriminatedUnion("state", [
  z.object({ state: z.literal("preparing"), location_id: LocationId, name: z.string(), size: z.number() }),
  z.object({ state: z.literal("failed"), location_id: LocationId, name: z.string(), error: z.string().nullable() }),
  z.object({
    state: z.literal("ready"),
    location_id: LocationId,
    sha256: Sha256,
    name: z.string(),
    path: z.string(),
    source_kind: SourceKind,
    mime: z.string(),
    size: z.number(),
    has_poster: z.boolean(),
    transcript: TranscriptState,
    transcript_error: z.string().nullable(),
    transcript_text: z.string().nullable(),
  }),
]);

export const ProtocolVideosRows = z.array(
  ProtocolVideoRow.transform((r): ProtocolVideo => {
    switch (r.state) {
      case "preparing":
        return { state: "preparing", locationId: r.location_id, name: r.name, size: r.size };
      case "failed":
        return { state: "failed", locationId: r.location_id, name: r.name, message: r.error ?? "We couldn't read this video." };
      case "ready":
        return {
          state: "ready",
          locationId: r.location_id,
          sha256: r.sha256,
          name: r.name,
          path: r.path,
          sourceKind: r.source_kind,
          mime: r.mime,
          size: r.size,
          hasPoster: r.has_poster,
          transcript: transcriptOf(r.transcript, r.transcript_error, r.transcript_text),
        };
      default: {
        const _exhaustive: never = r;
        return _exhaustive;
      }
    }
  }),
);

const TranscriptWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("waiting") }),
  z.object({ kind: z.literal("ready"), text: z.string() }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
]) satisfies z.ZodType<VideoTranscript>;

export const ProtocolVideosWire = z.array(
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("preparing"), locationId: LocationId, name: z.string(), size: z.number() }),
    z.object({ state: z.literal("failed"), locationId: LocationId, name: z.string(), message: z.string() }),
    z.object({
      state: z.literal("ready"),
      locationId: LocationId,
      sha256: Sha256,
      name: z.string(),
      path: z.string(),
      sourceKind: SourceKind,
      mime: z.string(),
      size: z.number(),
      hasPoster: z.boolean(),
      transcript: TranscriptWire,
    }),
  ]) satisfies z.ZodType<ProtocolVideo>,
);

export type ReadyVideo = Extract<ProtocolVideo, { state: "ready" }>;

// Polling stops once nothing on the page is still changing by itself.
export function isSettled(video: ProtocolVideo): boolean {
  switch (video.state) {
    case "preparing":
      return false;
    case "failed":
      return true;
    case "ready":
      return video.transcript.kind !== "waiting";
    default: {
      const _exhaustive: never = video;
      return _exhaustive;
    }
  }
}

// Plays in the page: a video we hold, or a Dropbox one through a temporary link.
export function playbackUrl(video: ReadyVideo): string {
  return `/api/files/${video.locationId}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

// Phone cameras name every recording the same; give each its own name.
export function recordedName(at: Date, type: VideoType): string {
  const ext = type === "video/quicktime" ? "mov" : type === "video/webm" ? "webm" : "mp4";
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `Video ${day} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}.${ext}`;
}
