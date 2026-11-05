import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseRange, startsAtBeginning } from "../byte-range";
import type { SendResult } from "../upload-queue";
import {
  bytesSent,
  nextStep,
  nextToSend,
  NO_UPLOADS,
  RETRY_DELAYS_MS,
  unsent,
  uploadsReducer,
  type StepDone,
  type Uploads,
} from "../video-upload-state";
import { partCount, partSpan, ProtocolVideosRows, refusedVideo, VIDEO_MAX_BYTES, VIDEO_PART_BYTES, VideoReceipt, VideoUploadId } from "../videos";

vi.mock("server-only", () => ({}));
const { fileResponse } = await import("../serve-file");

describe("byte ranges", () => {
  it("reads one range the way a video element asks", () => {
    expect(parseRange(null, 100)).toEqual({ kind: "whole" });
    expect(parseRange("bytes=0-", 100)).toEqual({ kind: "part", start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ kind: "part", start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ kind: "part", start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ kind: "part", start: 90, end: 99 });
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-1,5-9", 100)).toEqual({ kind: "whole" });
    expect(parseRange("items=0-1", 100)).toEqual({ kind: "whole" });
  });

  it("counts only the request that starts the file as opening it", () => {
    expect(startsAtBeginning(null)).toBe(true);
    expect(startsAtBeginning("bytes=0-")).toBe(true);
    expect(startsAtBeginning("bytes=524288-")).toBe(false);
  });

  it("serves a range of a stored file with its length and Content-Range", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bl-range-"));
    const path = join(dir, "clip");
    writeFileSync(path, Buffer.from("0123456789"));
    const headers = { "content-type": "video/mp4", "x-content-type-options": "nosniff" };

    const part = fileResponse({ path, size: 10, range: "bytes=2-5", headers });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("content-length")).toBe("4");
    expect(part.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await part.text()).toBe("2345");

    const whole = fileResponse({ path, size: 10, range: null, headers });
    expect([whole.status, whole.headers.get("accept-ranges"), await whole.text()]).toEqual([200, "bytes", "0123456789"]);

    const past = fileResponse({ path, size: 10, range: "bytes=10-", headers });
    expect([past.status, past.headers.get("content-range")]).toEqual([416, "bytes */10"]);
  });
});

describe("video limits", () => {
  it("takes phone videos up to the cap, and nothing else", () => {
    expect(refusedVideo({ type: "video/quicktime", size: VIDEO_MAX_BYTES })).toBeNull();
    expect(refusedVideo({ type: "video/mp4", size: VIDEO_MAX_BYTES + 1 })).toMatch(/up to 500 MB/);
    expect(refusedVideo({ type: "video/x-msvideo", size: 10 })).toMatch(/MP4, MOV or WebM/);
    expect(refusedVideo({ type: "text/html", size: 10 })).not.toBeNull();
    expect(refusedVideo({ type: "video/webm", size: 0 })).toMatch(/empty/);
  });

  it("cuts a file into equal parts with a shorter last one", () => {
    const size = 2 * VIDEO_PART_BYTES + 5;
    expect(partCount(size)).toBe(3);
    expect(partSpan(size, 1)).toEqual({ start: 0, end: VIDEO_PART_BYTES });
    expect(partSpan(size, 3)).toEqual({ start: 2 * VIDEO_PART_BYTES, end: size });
    expect(partCount(1)).toBe(1);
  });
});

const session = { uploadId: VideoUploadId.parse("9d1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001"), storeId: "s1" };
const stored = (done: StepDone): SendResult<StepDone> => ({ kind: "stored", receipt: done });
const dropped: SendResult<StepDone> = { kind: "interrupted", message: "The connection dropped." };

function withVideo(size: number): Uploads {
  return uploadsReducer(NO_UPLOADS, { type: "add", file: new Blob([new Uint8Array(size)], { type: "video/mp4" }), name: "clip.mp4", modifiedAt: null });
}

function step(uploads: Uploads, result: SendResult<StepDone>, now = 0): Uploads {
  const begun = uploadsReducer(uploads, { type: "begin", id: 1 });
  return uploadsReducer(begun, { type: "finish", id: 1, result, now });
}

describe("a video going up in parts", () => {
  it("starts, sends each part in order, then completes", () => {
    const size = VIDEO_PART_BYTES + 10;
    let u = withVideo(size);
    expect(nextStep(u.items[0]!)).toEqual({ kind: "start" });
    u = step(u, stored({ step: "start", session }));
    expect(nextStep(u.items[0]!)).toEqual({ kind: "part", partNumber: 1, start: 0, end: VIDEO_PART_BYTES });
    u = step(u, stored({ step: "part", part: { partNumber: 1, etag: '"a"' } }));
    u = uploadsReducer(uploadsReducer(u, { type: "begin", id: 1 }), { type: "progress", id: 1, sent: 4 });
    expect(bytesSent(u.items[0]!)).toBe(VIDEO_PART_BYTES + 4);
    u = uploadsReducer(u, { type: "finish", id: 1, result: stored({ step: "part", part: { partNumber: 2, etag: '"b"' } }), now: 0 });
    expect(nextStep(u.items[0]!)).toEqual({ kind: "complete" });
    expect(unsent(u)).toBe(1);
    const receipt = { locationId: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0009", sha256: "a".repeat(64), duplicate: false, linked: false };
    u = step(u, stored({ step: "complete", receipt: VideoReceipt.parse(receipt) }));
    expect(u.items[0]!.phase.kind).toBe("added");
    expect(unsent(u)).toBe(0);
  });

  it("keeps the parts it sent when one drops, retries after each delay, then waits for a tap", () => {
    let u = step(withVideo(3 * VIDEO_PART_BYTES), stored({ step: "start", session }));
    u = step(u, stored({ step: "part", part: { partNumber: 1, etag: '"a"' } }));
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
      u = step(u, dropped, 1_000);
      expect(u.items[0]!.phase).toEqual({ kind: "waiting", retryAt: 1_000 + delay, message: "The connection dropped." });
      expect(nextToSend(u)).toBeNull();
      u = uploadsReducer(u, { type: "retry", id: 1 });
      expect(u.items[0]!.failures).toBe(i + 1);
    }
    u = step(u, dropped, 1_000);
    expect(u.items[0]!.phase.kind).toBe("stopped");
    expect(u.items[0]!.parts).toHaveLength(1);
    u = uploadsReducer(u, { type: "online" });
    expect(nextStep(nextToSend(u)!)).toMatchObject({ kind: "part", partNumber: 2 });
    u = step(u, stored({ step: "part", part: { partNumber: 2, etag: '"b"' } }));
    expect(u.items[0]!.failures).toBe(0);
  });

  it("stops for good on a refusal, and never adds a video it can't take", () => {
    const refused = step(withVideo(10), { kind: "refused", message: "This page is archived." });
    expect(refused.items[0]!.phase).toEqual({ kind: "refused", message: "This page is archived." });
    expect(nextToSend(refused)).toBeNull();
    const notVideo = uploadsReducer(NO_UPLOADS, { type: "add", file: new Blob(["<p>"], { type: "text/html" }), name: "x.html", modifiedAt: null });
    expect(notVideo.items[0]!.phase.kind).toBe("refused");
  });

  it("sends one video at a time, and a removed one ignores its late answer", () => {
    let u = withVideo(10);
    u = uploadsReducer(u, { type: "add", file: new Blob([new Uint8Array(10)], { type: "video/mp4" }), name: "b.mp4", modifiedAt: null });
    u = uploadsReducer(u, { type: "begin", id: 1 });
    expect(nextToSend(u)).toBeNull();
    u = uploadsReducer(u, { type: "remove", id: 1 });
    u = uploadsReducer(u, { type: "finish", id: 1, result: dropped, now: 0 });
    expect(u.items.map((i) => i.id)).toEqual([2]);
    expect(nextToSend(u)?.id).toBe(2);
  });
});

describe("a page's videos", () => {
  it("reads each state from protocol_videos", () => {
    const rows = ProtocolVideosRows.parse([
      {
        state: "ready",
        location_id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001",
        sha256: "a".repeat(64),
        name: "clip.mp4",
        path: "/Uploads/Videos/clip.mp4",
        source_kind: "upload",
        mime: "video/mp4",
        size: 10,
        has_poster: false,
        transcript: "unavailable",
        transcript_error: "This video has no sound to transcribe.",
        transcript_text: null,
      },
      { state: "preparing", location_id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0002", name: "b.mp4", size: 5 },
      { state: "failed", location_id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003", name: "c.mp4", error: null },
    ]);
    expect(rows.map((r) => r.state)).toEqual(["ready", "preparing", "failed"]);
    expect(rows[0]).toMatchObject({ transcript: { kind: "unavailable", message: "This video has no sound to transcribe." } });
    expect(rows[2]).toMatchObject({ message: "We couldn't read this video." });
  });
});
