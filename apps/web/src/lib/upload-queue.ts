import type { z } from "zod";
import type { LocationId } from "./ids";
import { refusedKind, UPLOAD_MAX_BYTES, UploadReceipt, type UploadMeta } from "./uploads";

// The upload page's queue: files go up one at a time, oldest first, so a slow connection
// spends itself on one file instead of splitting across many. A dropped request waits and
// tries again by itself a few times, then waits for a tap. The queue lives as long as the page.

export type UploadResult = SendResult<UploadReceipt>;

export type SendResult<R> =
  | { kind: "stored"; receipt: R }
  // The server said no (too large, a video, signed out); trying again won't help.
  | { kind: "refused"; message: string }
  // The network or the server failed; the same request may well work in a moment.
  | { kind: "interrupted"; message: string };

export type ItemState =
  | { kind: "queued" }
  | { kind: "sending"; sent: number }
  | { kind: "waiting"; retryAt: number; message: string }
  | { kind: "stopped"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "stored"; locationId: LocationId; duplicate: boolean };

export type QueueItem = {
  id: number;
  file: Blob;
  meta: UploadMeta;
  // An object URL for images, so the row shows the photo before the worker has seen it.
  thumb: string | null;
  failures: number;
  state: ItemState;
};

export type NewItem = { file: Blob; meta: UploadMeta; thumb: string | null };

export type QueueAction =
  | { type: "add"; items: NewItem[] }
  | { type: "start"; id: number }
  | { type: "progress"; id: number; sent: number }
  | { type: "finish"; id: number; result: UploadResult; now: number }
  | { type: "retry"; id: number }
  | { type: "online" }
  | { type: "remove"; id: number };

export type Queue = { nextId: number; items: QueueItem[] };

export const EMPTY_QUEUE: Queue = { nextId: 1, items: [] };

// Waits before each automatic retry; after the last one a person taps Retry.
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

export function admit(file: Blob): ItemState {
  const refused = refusedKind(file.type);
  if (refused !== null) return { kind: "refused", message: refused };
  if (file.size > UPLOAD_MAX_BYTES) return { kind: "refused", message: `Files can be up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.` };
  if (file.size === 0) return { kind: "refused", message: "That file is empty." };
  return { kind: "queued" };
}

function update(queue: Queue, id: number, fn: (item: QueueItem) => QueueItem): Queue {
  return { ...queue, items: queue.items.map((item) => (item.id === id ? fn(item) : item)) };
}

function afterFailure(item: QueueItem, message: string, now: number): QueueItem {
  const failures = item.failures + 1;
  const delay = RETRY_DELAYS_MS[failures - 1];
  return {
    ...item,
    failures,
    state: delay === undefined ? { kind: "stopped", message } : { kind: "waiting", retryAt: now + delay, message },
  };
}

export function queueReducer(queue: Queue, action: QueueAction): Queue {
  switch (action.type) {
    case "add": {
      const added = action.items.map(
        (n, i): QueueItem => ({ id: queue.nextId + i, file: n.file, meta: n.meta, thumb: n.thumb, failures: 0, state: admit(n.file) }),
      );
      return { nextId: queue.nextId + added.length, items: [...queue.items, ...added] };
    }
    case "start":
      return update(queue, action.id, (item) => (item.state.kind === "queued" ? { ...item, state: { kind: "sending", sent: 0 } } : item));
    case "progress":
      return update(queue, action.id, (item) =>
        item.state.kind === "sending" ? { ...item, state: { kind: "sending", sent: action.sent } } : item,
      );
    case "finish":
      return update(queue, action.id, (item) => {
        if (item.state.kind !== "sending") return item;
        const { result } = action;
        switch (result.kind) {
          case "stored":
            return { ...item, state: { kind: "stored", locationId: result.receipt.locationId, duplicate: result.receipt.duplicate } };
          case "refused":
            return { ...item, state: { kind: "refused", message: result.message } };
          case "interrupted":
            return afterFailure(item, result.message, action.now);
          default: {
            const _exhaustive: never = result;
            return _exhaustive;
          }
        }
      });
    case "retry":
      return update(queue, action.id, (item) =>
        item.state.kind === "waiting" || item.state.kind === "stopped" ? { ...item, state: { kind: "queued" } } : item,
      );
    case "online":
      return {
        ...queue,
        items: queue.items.map((item) =>
          item.state.kind === "waiting" || item.state.kind === "stopped" ? { ...item, state: { kind: "queued" } } : item,
        ),
      };
    case "remove":
      return { ...queue, items: queue.items.filter((item) => item.id !== action.id || item.state.kind === "sending") };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

// The next file to send, or null while one is already going up.
export function nextToSend(queue: Queue): QueueItem | null {
  if (queue.items.some((item) => item.state.kind === "sending")) return null;
  return queue.items.find((item) => item.state.kind === "queued") ?? null;
}

// Files that would be lost if the page closed now.
export function unsent(queue: Queue): number {
  return queue.items.filter((item) => ["queued", "sending", "waiting", "stopped"].includes(item.state.kind)).length;
}

// What an HTTP answer means for the queue.
export function resultOf(status: number, body: unknown): UploadResult {
  return answerOf(status, body, UploadReceipt);
}

// The same reading for any upload; a talk-through's receipt names the talk-through too.
export function answerOf<R>(status: number, body: unknown, receiptSchema: z.ZodType<R>): SendResult<R> {
  const message =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
  if (status === 200 || status === 201) {
    const receipt = receiptSchema.safeParse(body);
    return receipt.success
      ? { kind: "stored", receipt: receipt.data }
      : { kind: "interrupted", message: "The server's answer was garbled." };
  }
  if (status === 0) return { kind: "interrupted", message: "The connection dropped." };
  if (status === 401) return { kind: "refused", message: "You're signed out. Sign in again, then add the file again." };
  if (status === 408 || status === 429 || status >= 500) return { kind: "interrupted", message: message ?? "The server didn't answer." };
  return { kind: "refused", message: message ?? `The server refused the file (${status}).` };
}
