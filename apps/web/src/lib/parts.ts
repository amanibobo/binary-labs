import { z } from "zod";

// Files that go straight to the store go in parts. Every part but the last is this size, as
// R2 requires. At 5 Mbps one part takes about 13 s, which is the most a dropped connection costs.
export const PART_BYTES = 8 * 1024 * 1024;

export function partCount(size: number): number {
  return Math.max(1, Math.ceil(size / PART_BYTES));
}

// Part n (from 1) of a file: its first byte and the byte after its last.
export function partSpan(size: number, n: number): { start: number; end: number } {
  const start = (n - 1) * PART_BYTES;
  return { start, end: Math.min(size, start + PART_BYTES) };
}

export const UploadedPart = z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) });
export type UploadedPart = z.infer<typeof UploadedPart>;
