import { z } from "zod";
import { SourceId } from "./ids";

export type ScanCounts = { pending: number; indexed: number; failed: number };

export type ScanState =
  | { kind: "queued"; counts: ScanCounts }
  | { kind: "running"; counts: ScanCounts }
  | { kind: "done"; counts: ScanCounts }
  | { kind: "error"; counts: ScanCounts; message: string };

export type SourceState =
  | { kind: "not_connected" }
  | { kind: "needs_folder"; sourceId: SourceId; accountLabel: string | null }
  | { kind: "connected"; sourceId: SourceId; accountLabel: string | null; rootPath: string; scan: ScanState };

type ScanTimes = {
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

const later = (a: string | null, b: string | null) => a !== null && (b === null || Date.parse(a) > Date.parse(b));

// Mirrors the worker's pickup rule (design.md): a request newer than the last start is queued.
export function deriveScan(times: ScanTimes, counts: ScanCounts): ScanState {
  if (later(times.requestedAt, times.startedAt) || times.startedAt === null) return { kind: "queued", counts };
  if (later(times.startedAt, times.finishedAt)) return { kind: "running", counts };
  if (times.error !== null) return { kind: "error", counts, message: times.error };
  return { kind: "done", counts };
}

// Listing can finish while files are still being read, so pending files keep it active.
export function isScanActive(scan: ScanState): boolean {
  switch (scan.kind) {
    case "queued":
    case "running":
      return true;
    case "done":
    case "error":
      return scan.counts.pending > 0;
    default: {
      const _exhaustive: never = scan;
      return _exhaustive;
    }
  }
}

const count = new Intl.NumberFormat("en-US");

export function progressLine(scan: ScanState): string {
  const { pending, indexed, failed } = scan.counts;
  const total = pending + indexed + failed;
  if (total === 0) {
    switch (scan.kind) {
      case "queued":
        return "Waiting for the scan to start";
      case "running":
        return "Listing files";
      case "done":
        return "No files found in this folder";
      case "error":
        return "The scan stopped before it found any files";
      default: {
        const _exhaustive: never = scan;
        return _exhaustive;
      }
    }
  }
  if (pending === 0) return `${count.format(indexed)} ${indexed === 1 ? "file" : "files"} indexed`;
  return `${count.format(indexed)} of ${count.format(total)} files indexed`;
}

export function failedLine(scan: ScanState): string | null {
  const { failed } = scan.counts;
  if (failed === 0) return null;
  return `${count.format(failed)} ${failed === 1 ? "file" : "files"} couldn't be read`;
}

export function progressFraction(scan: ScanState): number {
  const { pending, indexed, failed } = scan.counts;
  const total = pending + indexed + failed;
  return total === 0 ? 0 : (indexed + failed) / total;
}

const Counts = z.object({ pending: z.number(), indexed: z.number(), failed: z.number() });
const ScanStateWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued"), counts: Counts }),
  z.object({ kind: z.literal("running"), counts: Counts }),
  z.object({ kind: z.literal("done"), counts: Counts }),
  z.object({ kind: z.literal("error"), counts: Counts, message: z.string() }),
]);
export const SourceStateWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_connected") }),
  z.object({ kind: z.literal("needs_folder"), sourceId: SourceId, accountLabel: z.string().nullable() }),
  z.object({
    kind: z.literal("connected"),
    sourceId: SourceId,
    accountLabel: z.string().nullable(),
    rootPath: z.string(),
    scan: ScanStateWire,
  }),
]) satisfies z.ZodType<SourceState>;
