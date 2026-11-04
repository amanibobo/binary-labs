import { LabelRow } from "@/lib/domain";
import { LocationId, Sha256 } from "@/lib/ids";
import type { UploadResult } from "@/lib/upload-queue";
import type { UploadMeta, UploadRow } from "@/lib/uploads";

// The upload route and the worker in memory, for the upload fixture page. File names steer
// what happens, so a screenshot can show every state at once: a name with "Western" loses
// its connection every time, a PDF stalls at 64%, and anything else goes up and is read,
// then labeled, over a few seconds.

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(signal.reason);
    });
  });

const id = (n: number) => LocationId.parse(`7a1c2c39-5a4e-4c55-9d7b-${String(n).padStart(12, "0")}`);

const bm3 = { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ae001", name: "P450 BM3" };
const priya = { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7af002", name: "Priya Nair" };

const fixtureLabel = (cleanName: string, date: string, status: "suggested" | "check", tags: string[] = []) =>
  LabelRow.parse({
    status,
    clean_name: cleanName,
    date,
    experiment: bm3,
    person: priya,
    instrument: null,
    tags,
    confidence: status === "check" ? 0.62 : 0.91,
  });

// The first character picks the drawn preview in previews.ts: "c" is a gel photo.
const earlierRows: UploadRow[] = [
  {
    locationId: id(1),
    name: "Photo 2026-11-03 16.20.41.jpg",
    experiment: "P450 BM3",
    uploadedAt: "2026-11-03T21:20:41Z",
    progress: {
      kind: "labeled",
      fileKind: "image",
      hasPreview: true,
      sha256: Sha256.parse("c".repeat(64)),
      label: fixtureLabel("Batch 4 SDS-PAGE gel", "2026-11-03", "suggested", ["batch 4"]),
    },
  },
  {
    locationId: id(2),
    name: "Screenshot 2026-11-03 11.02.09.png",
    experiment: "P450 BM3",
    uploadedAt: "2026-11-03T16:02:09Z",
    progress: {
      kind: "labeled",
      fileKind: "image",
      hasPreview: false,
      sha256: Sha256.parse("8".repeat(64)),
      label: fixtureLabel("Batch 4 SEC trace", "2026-11-03", "check"),
    },
  },
];

const freshSha = Sha256.parse("f".repeat(64));

export function createFixtureUploads({ earlier }: { earlier: boolean }) {
  const rows = new Map<string, { row: UploadRow; at: number }>();
  let next = 100;

  function progressOf(entry: { row: UploadRow; at: number }): UploadRow {
    const age = Date.now() - entry.at;
    if (age < 1_200) return entry.row;
    if (age < 2_600) return { ...entry.row, progress: { kind: "labeling", fileKind: "image", hasPreview: false, sha256: freshSha } };
    return {
      ...entry.row,
      progress: {
        kind: "labeled",
        fileKind: "image",
        hasPreview: false,
        sha256: freshSha,
        label: fixtureLabel("Batch 5 SDS-PAGE gel", entry.row.uploadedAt.slice(0, 10), "suggested", ["batch 5"]),
      },
    };
  }

  return {
    uploadFile: async (file: Blob, meta: UploadMeta, onProgress: (sent: number) => void, signal: AbortSignal): Promise<UploadResult> => {
      try {
        if (meta.name.includes("Western")) {
          await wait(300, signal);
          onProgress(file.size * 0.3);
          await wait(300, signal);
          return { kind: "interrupted", message: "The connection dropped." };
        }
        if (meta.name.endsWith(".pdf")) {
          onProgress(file.size * 0.64);
          await wait(60 * 60 * 1000, signal);
        }
        for (const part of [0.25, 0.6, 1]) {
          await wait(150, signal);
          onProgress(file.size * part);
        }
      } catch {
        return { kind: "interrupted", message: "The upload was stopped." };
      }
      const locationId = id(next++);
      rows.set(locationId, {
        at: Date.now(),
        row: { locationId, name: meta.name, experiment: meta.experiment, uploadedAt: new Date().toISOString(), progress: { kind: "reading" } },
      });
      return { kind: "stored", receipt: { locationId, sha256: freshSha, duplicate: false } };
    },
    myUploads: async (signal: AbortSignal): Promise<UploadRow[]> => {
      await wait(120, signal);
      const fresh = [...rows.values()].map(progressOf).reverse();
      return [...fresh, ...(earlier ? earlierRows : [])];
    },
  };
}
