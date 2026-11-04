import { LabMemberRows, SearchFilesRows, type FileHit } from "@/lib/domain";
import { SourceId } from "@/lib/ids";
import type { SourceState } from "@/lib/source-state";

// Dev-only screenshot data. Imported only from *.dev.tsx pages, which production builds skip.

const source = "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003";
let n = 0;
const loc = (path: string, modified: string) => ({
  id: `6f1c2c39-5a4e-4c55-9d7b-${String(++n).padStart(12, "0")}`,
  source_id: source,
  source_kind: "dropbox",
  path,
  original_name: path.slice(path.lastIndexOf("/") + 1),
  modified_at: modified,
});

const row = (r: {
  c: string;
  kind: string;
  mime: string;
  preview: boolean;
  snippet: string | null;
  k: number | null;
  v: number | null;
  locations: ReturnType<typeof loc>[];
}) => ({
  sha256: r.c.repeat(64),
  score: 0.03,
  keyword_rank: r.k,
  vector_rank: r.v,
  snippet: r.snippet,
  file_kind: r.kind,
  mime: r.mime,
  size: 182_000,
  has_preview: r.preview,
  locations: r.locations,
});

export const searchHits = SearchFilesRows.parse([
  row({
    c: "a",
    kind: "image",
    mime: "image/jpeg",
    preview: true,
    snippet: "Lab Gels 2026-10 Batch 3 IMG_4821.jpg",
    k: 1,
    v: 1,
    locations: [loc("/Lab/Gels/2026-10 Batch 3/IMG_4821.jpg", "2026-10-14T16:12:00Z")],
  }),
  row({
    c: "b",
    kind: "pdf",
    mime: "application/pdf",
    preview: true,
    snippet:
      "Section 4. Run SDS-PAGE gels for each P450 BM3 batch after the nickel column. Load 10 µL per lane next to the ladder, stain with Coomassie for 30 min, and keep the gel photo with the batch number in the file name.",
    k: 2,
    v: 3,
    locations: [
      loc("/Lab/Protocols/P450 purification v3.pdf", "2026-09-30T10:00:00Z"),
      loc("/Lab/Archive/2025/P450 purification v3.pdf", "2025-11-02T10:00:00Z"),
    ],
  }),
  row({
    c: "d",
    kind: "spreadsheet",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    preview: false,
    snippet: "Sheet Gel densitometry: Lane, Sample, Band intensity (a.u.), P450 conc (µM). Sheet Batch 3 summary: Yield (mg/L), A420/A280.",
    k: null,
    v: 2,
    locations: [loc("/Lab/Data/Batch 3/final_v2_REAL.xlsx", "2026-10-16T08:40:00Z")],
  }),
  row({
    c: "e",
    kind: "text",
    mime: "text/plain",
    preview: false,
    snippet:
      "Oct 14. Batch 3 P450 looks clean on the gel, one faint band near 25 kDa. Reran lane 6. Ask Priya whether the SEC trace matches.",
    k: 3,
    v: null,
    locations: [loc("/Lab/People/AO/notes 2026-10-14.txt", "2026-10-14T21:05:00Z")],
  }),
  row({
    c: "f",
    kind: "other",
    mime: "text/csv",
    preview: false,
    snippet: null,
    k: null,
    v: 4,
    locations: [loc("/Lab/Instruments/AKTA/SEC_trace_141026.csv", "2026-10-14T13:20:00Z")],
  }),
]);

const recentOnly = SearchFilesRows.parse([
  row({
    c: "1",
    kind: "spreadsheet",
    mime: "text/csv",
    preview: false,
    snippet: "Plate 7, absorbance at 420 nm, wells A1 to H12, blank-corrected.",
    k: null,
    v: null,
    locations: [loc("/Lab/Instruments/Plate reader/plate7_A420.csv", "2026-11-03T17:44:00Z")],
  }),
  row({
    c: "2",
    kind: "image",
    mime: "image/jpeg",
    preview: true,
    snippet: null,
    k: null,
    v: null,
    locations: [loc("/Lab/Gels/2026-11/IMG_4930.jpg", "2026-11-03T15:02:00Z")],
  }),
  row({
    c: "3",
    kind: "document",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    preview: false,
    snippet: "Rotation project plan: express CYP102A1 variants, purify, and compare activity against wild type.",
    k: null,
    v: null,
    locations: [loc("/Lab/People/JM/rotation plan.docx", "2026-11-02T11:30:00Z")],
  }),
]);

export const recentFiles: FileHit[] = [...recentOnly, ...searchHits.slice(0, 2).map((h) => ({ ...h, matchedBy: [] }))];

export const scanningSource: SourceState = {
  kind: "connected",
  sourceId: SourceId.parse(source),
  accountLabel: "a.okafor@university.edu",
  rootPath: "/Lab",
  scan: { kind: "running", counts: { pending: 1565, indexed: 412, failed: 3 } },
};

export const doneSource: SourceState = {
  ...scanningSource,
  scan: { kind: "done", counts: { pending: 0, indexed: 1977, failed: 3 } },
};

export const members = LabMemberRows.parse([
  { user_id: "00000000-0000-4000-8000-00000000000a", email: "a.okafor@university.edu", role: "admin", joined_at: "2026-11-04T09:00:00Z" },
  { user_id: "00000000-0000-4000-8000-00000000000b", email: "priya.n@university.edu", role: "member", joined_at: "2026-11-04T09:20:00Z" },
  { user_id: "00000000-0000-4000-8000-00000000000c", email: "j.morales@university.edu", role: "member", joined_at: "2026-11-04T10:05:00Z" },
]);

export const folders: Record<string, { name: string; path: string }[]> = {
  "": [
    { name: "Apps", path: "/Apps" },
    { name: "Lab", path: "/Lab" },
    { name: "Personal", path: "/Personal" },
  ],
  "/Lab": ["Archive", "Data", "Gels", "Instruments", "People", "Protocols"].map((name) => ({ name, path: `/Lab/${name}` })),
};
