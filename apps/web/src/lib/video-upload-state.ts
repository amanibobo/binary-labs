import type { SendResult } from "./upload-queue";
import { partCount, partSpan, type UploadedPart } from "./parts";
import { refusedVideo, type VideoReceipt, type VideoSession } from "./videos";

// A page's videos on their way up. Each goes in parts, one request at a time: a dropped part
// is sent again by itself after 2, 5 and 15 s, then waits for a tap or for the browser to come
// back online, and the parts already sent stay sent. Videos go one after another.

export type Phase =
  // The driver should take the next step.
  | { kind: "ready" }
  | { kind: "busy"; sent: number }
  | { kind: "waiting"; retryAt: number; message: string }
  | { kind: "stopped"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "added"; receipt: VideoReceipt };

export type VideoUpload = {
  id: number;
  file: Blob;
  name: string;
  modifiedAt: number | null;
  session: VideoSession | null;
  // Parts the store has, in order from part 1.
  parts: UploadedPart[];
  // Failures in a row since the last request that worked.
  failures: number;
  phase: Phase;
};

// What the driver does next, read off the upload rather than kept beside it.
export type Step =
  | { kind: "start" }
  | { kind: "part"; partNumber: number; start: number; end: number }
  | { kind: "complete" };

export function nextStep(upload: VideoUpload): Step {
  if (upload.session === null) return { kind: "start" };
  const n = upload.parts.length + 1;
  if (n <= partCount(upload.file.size)) return { kind: "part", partNumber: n, ...partSpan(upload.file.size, n) };
  return { kind: "complete" };
}

// What a step that worked hands back.
export type StepDone =
  | { step: "start"; session: VideoSession }
  | { step: "part"; part: UploadedPart }
  | { step: "complete"; receipt: VideoReceipt };

export type UploadsAction =
  | { type: "add"; file: Blob; name: string; modifiedAt: number | null }
  | { type: "begin"; id: number }
  | { type: "progress"; id: number; sent: number }
  | { type: "finish"; id: number; result: SendResult<StepDone>; now: number }
  | { type: "retry"; id: number }
  | { type: "online" }
  | { type: "remove"; id: number };

export type Uploads = { nextId: number; items: VideoUpload[] };

export const NO_UPLOADS: Uploads = { nextId: 1, items: [] };

export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

function update(uploads: Uploads, id: number, fn: (u: VideoUpload) => VideoUpload): Uploads {
  return { ...uploads, items: uploads.items.map((u) => (u.id === id ? fn(u) : u)) };
}

function interrupted(upload: VideoUpload, message: string, now: number): VideoUpload {
  const failures = upload.failures + 1;
  const delay = RETRY_DELAYS_MS[failures - 1];
  return {
    ...upload,
    failures,
    phase: delay === undefined ? { kind: "stopped", message } : { kind: "waiting", retryAt: now + delay, message },
  };
}

function finish(upload: VideoUpload, result: SendResult<StepDone>, now: number): VideoUpload {
  switch (result.kind) {
    case "refused":
      return { ...upload, phase: { kind: "refused", message: result.message } };
    case "interrupted":
      return interrupted(upload, result.message, now);
    case "stored":
      return afterStep({ ...upload, failures: 0, phase: { kind: "ready" } }, result.receipt);
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

function afterStep(upload: VideoUpload, done: StepDone): VideoUpload {
  switch (done.step) {
    case "start":
      return { ...upload, session: done.session };
    case "part":
      return { ...upload, parts: [...upload.parts, done.part] };
    case "complete":
      return { ...upload, phase: { kind: "added", receipt: done.receipt } };
    default: {
      const _exhaustive: never = done;
      return _exhaustive;
    }
  }
}

export function uploadsReducer(uploads: Uploads, action: UploadsAction): Uploads {
  switch (action.type) {
    case "add": {
      const refused = refusedVideo(action.file);
      const upload: VideoUpload = {
        id: uploads.nextId,
        file: action.file,
        name: action.name,
        modifiedAt: action.modifiedAt,
        session: null,
        parts: [],
        failures: 0,
        phase: refused === null ? { kind: "ready" } : { kind: "refused", message: refused },
      };
      return { nextId: uploads.nextId + 1, items: [...uploads.items, upload] };
    }
    case "begin":
      return update(uploads, action.id, (u) => (u.phase.kind === "ready" ? { ...u, phase: { kind: "busy", sent: 0 } } : u));
    case "progress":
      return update(uploads, action.id, (u) => (u.phase.kind === "busy" ? { ...u, phase: { kind: "busy", sent: action.sent } } : u));
    case "finish":
      return update(uploads, action.id, (u) => (u.phase.kind === "busy" ? finish(u, action.result, action.now) : u));
    case "retry":
      return update(uploads, action.id, (u) =>
        u.phase.kind === "waiting" || u.phase.kind === "stopped" ? { ...u, phase: { kind: "ready" } } : u,
      );
    case "online":
      return {
        ...uploads,
        items: uploads.items.map((u) => (u.phase.kind === "waiting" || u.phase.kind === "stopped" ? { ...u, phase: { kind: "ready" } } : u)),
      };
    case "remove":
      // A request still in flight for it finds nothing to update when it ends.
      return { ...uploads, items: uploads.items.filter((u) => u.id !== action.id) };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

// The one upload to act on now, or null while one is busy or none is ready.
export function nextToSend(uploads: Uploads): VideoUpload | null {
  if (uploads.items.some((u) => u.phase.kind === "busy")) return null;
  return uploads.items.find((u) => u.phase.kind === "ready") ?? null;
}

// Bytes the store has for this upload, counting the part going up now.
export function bytesSent(upload: VideoUpload): number {
  const done = upload.parts.reduce((sum, p) => {
    const span = partSpan(upload.file.size, p.partNumber);
    return sum + span.end - span.start;
  }, 0);
  const step = nextStep(upload);
  return upload.phase.kind === "busy" && step.kind === "part" ? done + upload.phase.sent : done;
}

// Uploads that would be lost if the page closed now.
export function unsent(uploads: Uploads): number {
  return uploads.items.filter((u) => u.phase.kind !== "refused" && u.phase.kind !== "added").length;
}
