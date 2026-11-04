import { describe, expect, it } from "vitest";
import { deriveScan, failedLine, isScanActive, progressLine } from "../source-state";

const counts = { pending: 1568, indexed: 412, failed: 0 };
const t = (h: number) => `2026-11-04T${String(h).padStart(2, "0")}:00:00Z`;

describe("deriveScan", () => {
  it("is queued when a request is newer than the last start", () => {
    expect(deriveScan({ requestedAt: t(3), startedAt: t(1), finishedAt: t(2), error: null }, counts).kind).toBe("queued");
    expect(deriveScan({ requestedAt: t(3), startedAt: null, finishedAt: null, error: null }, counts).kind).toBe("queued");
  });

  it("is running after a start with no later finish", () => {
    expect(deriveScan({ requestedAt: t(1), startedAt: t(2), finishedAt: null, error: null }, counts).kind).toBe("running");
    expect(deriveScan({ requestedAt: t(1), startedAt: t(3), finishedAt: t(2), error: null }, counts).kind).toBe("running");
  });

  it("is done or error once finished", () => {
    expect(deriveScan({ requestedAt: t(1), startedAt: t(2), finishedAt: t(3), error: null }, counts).kind).toBe("done");
    expect(deriveScan({ requestedAt: t(1), startedAt: t(2), finishedAt: t(3), error: "expired token" }, counts)).toEqual({
      kind: "error",
      counts,
      message: "expired token",
    });
  });
});

describe("progress copy", () => {
  it("reads like the PRD example with thousands separators", () => {
    expect(progressLine({ kind: "running", counts })).toBe("412 of 1,980 files indexed");
  });

  it("counts failed files plainly and keeps them out of the indexed number", () => {
    const scan = { kind: "done", counts: { pending: 0, indexed: 1977, failed: 3 } } as const;
    expect(progressLine(scan)).toBe("1,977 files indexed");
    expect(failedLine(scan)).toBe("3 files couldn't be read");
    expect(failedLine({ kind: "done", counts: { pending: 0, indexed: 1, failed: 1 } })).toBe("1 file couldn't be read");
    expect(failedLine({ kind: "done", counts })).toBeNull();
  });

  it("stays active while files are pending after listing finished", () => {
    expect(isScanActive({ kind: "done", counts })).toBe(true);
    expect(isScanActive({ kind: "done", counts: { pending: 0, indexed: 2, failed: 0 } })).toBe(false);
    expect(isScanActive({ kind: "queued", counts: { pending: 0, indexed: 0, failed: 0 } })).toBe(true);
  });
});
