import { describe, expect, it } from "vitest";
import { ProtocolId, ProtocolVersionId, Sha256, TalkThroughId } from "../ids";
import { elapsedMs, recorderReducer, type RecorderState, type Take } from "../recorder-state";
import {
  editorStart,
  formatClock,
  isTalkThroughUpload,
  parseTalkThroughHeaders,
  RECORDING_MAX_MS,
  recordingFormat,
  recordingName,
  refusedRecording,
  statusOf,
  talkThroughHeaders,
  TalkThroughWire,
  type TalkThrough,
  type TalkThroughMeta,
} from "../talk-throughs";

const page = ProtocolId.parse("7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001");
const base = ProtocolVersionId.parse("7a1c2c39-5a4e-4c55-9d7b-0c3c1a7b0004");
const meta = (target: TalkThroughMeta["target"]): TalkThroughMeta => ({
  name: "Talk-through 2026-11-04 14.03.22.weba",
  uploadedOn: "2026-11-04",
  modifiedAt: null,
  durationMs: 192_400,
  target,
});

describe("talk-through upload headers", () => {
  it("carry a new page's kind or a page and its version, and come back the same", () => {
    for (const target of [{ kind: "new", pageKind: "tutorial" }, { kind: "page", protocolId: page, baseVersionId: base }] as const) {
      const headers = new Headers(talkThroughHeaders(meta(target)));
      expect(isTalkThroughUpload(headers)).toBe(true);
      expect(parseTalkThroughHeaders(headers)).toEqual(meta(target));
    }
  });

  it("refuse a page without its version, or both a page and a new kind", () => {
    const without = (headers: Record<string, string>, name: string) => {
      const out = new Headers(headers);
      out.delete(name);
      return out;
    };
    const full = talkThroughHeaders(meta({ kind: "page", protocolId: page, baseVersionId: base }));
    expect(parseTalkThroughHeaders(without(full, "x-talk-through-base"))).toBeNull();
    expect(parseTalkThroughHeaders(new Headers({ ...full, "x-talk-through-kind": "protocol" }))).toBeNull();
    expect(parseTalkThroughHeaders(without(talkThroughHeaders(meta({ kind: "new", pageKind: "protocol" })), "x-talk-through-kind"))).toBeNull();
  });

  it("aren't mistaken for a photo upload", () => {
    expect(isTalkThroughUpload(new Headers({ "x-upload-name": "gel.jpg" }))).toBe(false);
  });
});

describe("recording", () => {
  it("records Opus in WebM where it can and AAC in MP4 on Safari", () => {
    expect(recordingFormat((t) => t.startsWith("audio/webm"))).toEqual({ mimeType: "audio/webm;codecs=opus", extension: "weba" });
    expect(recordingFormat((t) => t === "audio/mp4")).toEqual({ mimeType: "audio/mp4", extension: "m4a" });
    expect(recordingFormat(() => false)).toBeNull();
  });

  it("names a take by its local time and counts the clock up past an hour", () => {
    expect(recordingName(new Date(2026, 10, 4, 9, 5, 7), "m4a")).toBe("Talk-through 2026-11-04 09.05.07.m4a");
    expect([formatClock(0), formatClock(61_900), formatClock(RECORDING_MAX_MS), formatClock(3_725_000)]).toEqual(["00:00", "01:01", "30:00", "1:02:05"]);
  });

  it("takes sound only", () => {
    expect(refusedRecording("audio/mp4")).toBeNull();
    expect(refusedRecording("audio/webm;codecs=opus")).toBeNull();
    expect(refusedRecording("video/webm")).not.toBeNull();
  });

  it("counts only the time spent recording, across pauses", () => {
    let s: RecorderState = { kind: "idle", problem: null };
    s = recorderReducer(s, { type: "start" });
    s = recorderReducer(s, { type: "started", at: 1_000 });
    expect(elapsedMs(s, 4_000)).toBe(3_000);
    s = recorderReducer(s, { type: "pause", at: 5_000 });
    expect(elapsedMs(s, 60_000)).toBe(4_000);
    s = recorderReducer(s, { type: "resume", at: 60_000 });
    expect(elapsedMs(s, 61_500)).toBe(5_500);
    // A second "started" (a double tap) doesn't restart the clock.
    expect(recorderReducer(s, { type: "started", at: 99_000 })).toBe(s);
  });

  it("keeps the take through a failed send so it can go again", () => {
    const take: Take = { blob: new Blob(["x"]), url: "blob:x", name: "a.weba", type: "audio/webm", durationMs: 5_000, madeHere: true };
    let s: RecorderState = recorderReducer({ kind: "idle", problem: null }, { type: "picked", take });
    s = recorderReducer(s, { type: "send" });
    s = recorderReducer(s, { type: "progress", sent: 1 });
    s = recorderReducer(s, { type: "send_failed", message: "The connection dropped.", retryable: true });
    expect(s).toEqual({ kind: "send_failed", take, message: "The connection dropped.", retryable: true });
    expect(recorderReducer(s, { type: "send" })).toEqual({ kind: "sending", take, sent: 0 });
    expect(recorderReducer({ kind: "idle", problem: null }, { type: "send" })).toEqual({ kind: "idle", problem: null });
    // A file's length read late lands on a take still waiting, never on one being sent.
    const picked = recorderReducer({ kind: "idle", problem: null }, { type: "picked", take });
    expect(recorderReducer(picked, { type: "duration", ms: 9_000 })).toMatchObject({ kind: "recorded", take: { durationMs: 9_000 } });
    const sending = recorderReducer(picked, { type: "send" });
    expect(recorderReducer(sending, { type: "duration", ms: 9_000 })).toBe(sending);
  });
});

const row: Parameters<typeof statusOf>[0] = {
  index_state: "indexed",
  index_error: null,
  sha256: Sha256.parse("a".repeat(64)),
  transcript: "Thaw the pellet on ice.",
  draft: "waiting",
  draft_title: null,
  draft_body: null,
  draft_error: null,
};

describe("a talk-through's status", () => {
  it("follows the audio, then the draft", () => {
    expect(statusOf({ ...row, index_state: "pending", sha256: null, transcript: null }).kind).toBe("transcribing");
    expect(statusOf({ ...row, index_state: "failed", index_error: "ElevenLabs answered 401" })).toEqual({
      kind: "failed",
      stage: "transcribe",
      transcript: null,
      message: "ElevenLabs answered 401",
    });
    expect(statusOf(row)).toEqual({ kind: "drafting", transcript: "Thaw the pellet on ice." });
    expect(statusOf({ ...row, draft: "ready", draft_title: "Lysis", draft_body: "## Steps\n\n1. Thaw." })).toEqual({
      kind: "ready",
      transcript: "Thaw the pellet on ice.",
      title: "Lysis",
      body: "## Steps\n\n1. Thaw.",
    });
    expect(statusOf({ ...row, draft: "failed", draft_error: "Try again." })).toMatchObject({ kind: "failed", stage: "draft" });
    expect(statusOf({ ...row, draft: "unavailable", draft_error: "No model." })).toMatchObject({ kind: "no_draft", message: "No model." });
  });

  it("starts the editor from the steps, or the transcript when asked or when no steps came", () => {
    const tt = (status: ReturnType<typeof statusOf>, used: TalkThrough["used"] = null, forPage = true): TalkThrough =>
      TalkThroughWire.parse({
        id: TalkThroughId.parse("5b1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001"),
        kind: "protocol",
        page: forPage ? { protocolId: page, title: "Lysis", baseVersionId: base, baseVersion: 4 } : null,
        recordedBy: null,
        recordedAt: "2026-11-04T14:03:22Z",
        durationMs: null,
        audio: { locationId: "7a1c2c39-5a4e-4c55-9d7b-000000000090", name: "a.weba" },
        status,
        used,
      });
    const ready = statusOf({ ...row, draft: "ready", draft_title: "BM3 lysis", draft_body: "1. Thaw." });
    // A page keeps its title; the drafted title names a new page.
    expect(editorStart(tt(ready), "steps")).toEqual({ title: "Lysis", body: "1. Thaw.", from: "steps" });
    expect(editorStart(tt(ready, null, false), "steps")).toEqual({ title: "BM3 lysis", body: "1. Thaw.", from: "steps" });
    expect(editorStart(tt(ready), "transcript")).toEqual({ title: "Lysis", body: "Thaw the pellet on ice.", from: "transcript" });
    expect(editorStart(tt(statusOf({ ...row, draft: "unavailable", draft_error: "x" })), "steps")?.from).toBe("transcript");
    expect(editorStart(tt({ kind: "transcribing" }), "steps")).toBeNull();
    expect(editorStart(tt(ready, { protocolId: page, version: 5 }), "steps")).toBeNull();
  });
});
