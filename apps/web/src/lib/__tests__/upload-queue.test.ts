import { describe, expect, it } from "vitest";
import { LocationId, Sha256 } from "../ids";
import { EMPTY_QUEUE, nextToSend, queueReducer, resultOf, RETRY_DELAYS_MS, unsent, type Queue, type QueueAction } from "../upload-queue";
import { UPLOAD_MAX_BYTES, type UploadMeta } from "../uploads";

const meta: UploadMeta = { name: "gel.jpg", experiment: "P450 BM3", uploadedOn: "2026-11-04", modifiedAt: null };
const file = (size: number, type = "image/jpeg") => new Blob([new Uint8Array(size)], { type });
const receipt = {
  locationId: LocationId.parse("55555555-5555-4555-8555-555555555555"),
  sha256: Sha256.parse("c".repeat(64)),
  duplicate: false,
};

const run = (actions: QueueAction[], from: Queue = EMPTY_QUEUE) => actions.reduce(queueReducer, from);
const states = (q: Queue) => q.items.map((i) => i.state.kind);
const add = (...files: Blob[]): QueueAction => ({ type: "add", items: files.map((f) => ({ file: f, meta, thumb: null })) });
const drop: (id: number, now?: number) => QueueAction = (id, now = 0) => ({ type: "finish", id, now, result: { kind: "interrupted", message: "The connection dropped." } });

describe("the upload queue", () => {
  it("sends one file at a time, oldest first", () => {
    const q = run([add(file(10), file(20)), { type: "start", id: 1 }]);
    expect(states(q)).toEqual(["sending", "queued"]);
    expect(nextToSend(q)).toBeNull();
    const done = run([{ type: "finish", id: 1, now: 0, result: { kind: "stored", receipt } }], q);
    expect(nextToSend(done)?.id).toBe(2);
    expect(done.items[0]?.state).toEqual({ kind: "stored", locationId: receipt.locationId, duplicate: false });
  });

  it("turns away oversize files, videos and empty files before sending a byte", () => {
    const q = run([add(file(UPLOAD_MAX_BYTES + 1), file(10, "video/mp4"), file(0), file(UPLOAD_MAX_BYTES))]);
    expect(states(q)).toEqual(["refused", "refused", "refused", "queued"]);
    expect(nextToSend(q)?.id).toBe(4);
  });

  it("retries a dropped upload by itself, then waits for a tap, and never loses the file", () => {
    let q = run([add(file(10)), { type: "start", id: 1 }, drop(1, 1000)]);
    expect(q.items[0]?.state).toEqual({ kind: "waiting", retryAt: 1000 + RETRY_DELAYS_MS[0], message: "The connection dropped." });
    q = RETRY_DELAYS_MS.reduce((acc) => run([{ type: "retry", id: 1 }, { type: "start", id: 1 }, drop(1)], acc), q);
    expect(states(q)).toEqual(["stopped"]);
    expect(unsent(q)).toBe(1);
    q = run([{ type: "retry", id: 1 }, { type: "start", id: 1 }, { type: "finish", id: 1, now: 0, result: { kind: "stored", receipt } }], q);
    expect(states(q)).toEqual(["stored"]);
    expect(unsent(q)).toBe(0);
  });

  it("requeues everything waiting when the connection comes back", () => {
    const q = run([add(file(10), file(10)), { type: "start", id: 1 }, drop(1), { type: "online" }]);
    expect(states(q)).toEqual(["queued", "queued"]);
  });

  it("ignores late answers for a file that isn't sending, and won't remove one mid-send", () => {
    const q = run([add(file(10)), { type: "finish", id: 1, now: 0, result: { kind: "stored", receipt } }, { type: "start", id: 1 }, { type: "remove", id: 1 }]);
    expect(states(q)).toEqual(["sending"]);
  });
});

describe("reading the server's answer", () => {
  it("retries network failures, timeouts and server errors, and stops on refusals", () => {
    expect(resultOf(201, receipt)).toEqual({ kind: "stored", receipt });
    expect(resultOf(0, null).kind).toBe("interrupted");
    expect(resultOf(408, { error: "The upload was cut off. Try again." })).toEqual({ kind: "interrupted", message: "The upload was cut off. Try again." });
    expect(resultOf(503, null).kind).toBe("interrupted");
    expect(resultOf(200, { nonsense: true }).kind).toBe("interrupted");
    expect(resultOf(413, { error: "Files can be up to 50 MB." })).toEqual({ kind: "refused", message: "Files can be up to 50 MB." });
    expect(resultOf(401, { error: "sign in first" }).kind).toBe("refused");
  });
});
