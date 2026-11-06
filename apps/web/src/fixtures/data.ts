import {
  ExperimentRows,
  LabelRow,
  LabMemberRows,
  NeedsLookRows,
  PersonRows,
  SearchFilesRows,
  type FileHit,
  type Label,
} from "@/lib/domain";
import { FOLDER_PAGE_SIZE, FolderFilesRows, FolderTreeRows, type FolderPath } from "@/lib/folders";
import type { ShellData } from "@/lib/shell-data";
import { SourceId } from "@/lib/ids";
import type { SourceState } from "@/lib/source-state";
import { fixtureOnboarding } from "./onboarding";

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

// Uploads live on the lab's upload source and open from our store, not Dropbox.
const uploadLoc = (path: string, modified: string) => ({
  ...loc(path, modified),
  source_id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0004",
  source_kind: "upload",
});

export const experiments = ExperimentRows.parse([
  { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ae001", name: "P450 BM3", aliases: ["BM3", "CYP102A1"] },
  { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ae002", name: "Solubility screen", aliases: ["sol screen"] },
  { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ae003", name: "Rotation projects", aliases: [] },
]);

export const people = PersonRows.parse([
  { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7af001", display_name: "Ade Okafor", aliases: ["AO", "Ade"] },
  { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7af002", display_name: "Priya Nair", aliases: ["PN", "Priya"] },
  { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7af003", display_name: "Jordan Morales", aliases: ["JM"] },
]);

const [bm3, solubility, rotation] = experiments.map((e) => ({ id: e.id, name: e.name }));
const [ade, priya, jordan] = people.map((p) => ({ id: p.id, name: p.name }));

type LabelInput = {
  status: Label["status"];
  clean_name: string | null;
  date?: string;
  experiment?: { id: string; name: string };
  person?: { id: string; name: string };
  instrument?: string;
  tags?: string[];
  confidence?: number;
};

const label = (l: LabelInput) => ({
  status: l.status,
  clean_name: l.clean_name,
  date: l.date ?? null,
  experiment: l.experiment ?? null,
  person: l.person ?? null,
  instrument: l.instrument ?? null,
  tags: l.tags ?? [],
  confidence: l.confidence ?? 0.9,
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
  label: ReturnType<typeof label> | null;
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
  label: r.label,
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
    label: label({ status: "suggested", clean_name: "Batch 3 SDS-PAGE gel", date: "2026-10-14", experiment: bm3, person: priya, instrument: "ChemiDoc", tags: ["batch 3"] }),
  }),
  row({
    c: "c",
    kind: "image",
    mime: "image/jpeg",
    preview: true,
    snippet: "SDS-PAGE gel of P450 BM3 batch 4 after the nickel column: a strong band near 119 kDa in lanes 2 to 7, ladder in lane 1.",
    k: 2,
    v: 2,
    locations: [uploadLoc("/Uploads/P450 BM3/Photo 2026-11-03 16.20.41.jpg", "2026-11-03T21:20:41Z")],
    label: label({ status: "suggested", clean_name: "Batch 4 SDS-PAGE gel", date: "2026-11-03", experiment: bm3, person: priya, tags: ["batch 4"] }),
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
    label: label({ status: "accepted", clean_name: "P450 BM3 purification protocol, v3", experiment: bm3, tags: ["protocol"], confidence: 1 }),
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
    label: label({ status: "check", clean_name: "Batch 3 gel densitometry", date: "2026-10-16", experiment: bm3, person: ade, tags: ["batch 3"], confidence: 0.55 }),
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
    label: label({ status: "suggested", clean_name: "Bench notes, Oct 14", date: "2026-10-14", person: ade, tags: ["batch 3"] }),
  }),
  row({
    c: "f",
    kind: "spreadsheet",
    mime: "text/csv",
    preview: false,
    snippet: null,
    k: null,
    v: 4,
    locations: [loc("/Lab/Instruments/AKTA/SEC_trace_141026.csv", "2026-10-14T13:20:00Z")],
    label: null,
  }),
]);

const recentOnly = SearchFilesRows.parse([
  row({
    c: "1",
    kind: "spreadsheet",
    mime: "text/csv",
    preview: false,
    // What extraction keeps of a Gen5 kinetic export: the instrument's header first.
    snippet: [
      "Software Version | 3.11.19",
      "Experiment File Path: | C:\\Users\\Public\\Documents\\Experiments\\plate7_A420.xpt",
      "Plate Number | Plate 7",
      "Date | 11/3/2026",
      "Time | 5:44:12 PM",
      "Reader Type: | Synergy H1",
      "Reader Serial Number: | 21031514",
      "Reading Type | Reader",
      "Procedure Details",
      "Plate Type | 96 WELL PLATE (Use plate lid)",
      "Set Temperature | Setpoint 30°C",
      "Start Kinetic | Runtime 0:30:00 (HH:MM:SS), Interval 0:01:00, 31 Reads",
      "Read | Absorbance Endpoint",
      "Time | T° Read 1:420 | A1 | A2 | A3 | A4 | A5 | A6",
      "0:00:00 | 30 | 0.079 | 0.082 | 0.081 | 0.084 | 0.08 | 0.083",
    ].join("\n"),
    k: null,
    v: null,
    locations: [loc("/Lab/Instruments/Plate reader/plate7_A420.csv", "2026-11-03T17:44:00Z")],
    label: label({
      status: "check",
      clean_name: "Plate 7 absorbance at 420 nm",
      date: "2026-11-03",
      experiment: solubility,
      person: ade,
      instrument: "Plate reader",
      tags: ["absorbance", "kinetic", "420 nm", "plate 7", "96-well"],
      confidence: 0.6,
    }),
  }),
  row({
    c: "4",
    kind: "spreadsheet",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    preview: false,
    snippet: "Sheet Standards: BSA (µg/mL), A595 (AU) Rep 1 to 3, Mean (AU), SD (AU). Sheet Samples. Sheet Plate.",
    k: null,
    v: null,
    locations: [loc("/Lab/Data/Bradford/Bradford_2026-10-30.xlsx", "2026-10-30T15:10:00Z")],
    label: label({ status: "suggested", clean_name: "Bradford assay, Oct 30", date: "2026-10-30", experiment: bm3, person: priya, instrument: "Plate reader" }),
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
    label: label({ status: "needs_look", clean_name: null, confidence: 0.2 }),
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
    label: null,
  }),
]);

export const recentFiles: FileHit[] = [...recentOnly, ...searchHits.slice(0, 2).map((h) => ({ ...h, matchedBy: [] }))];

// Labels the fixture API hands out when the results list polls for files that had none.
export const laterLabels: Record<string, Label> = {
  ["f".repeat(64)]: LabelRow.parse(
    label({ status: "suggested", clean_name: "SEC trace, batch 3", date: "2026-10-14", experiment: bm3, instrument: "ÄKTA pure", tags: ["batch 3"] }),
  ),
  ["3".repeat(64)]: LabelRow.parse(label({ status: "suggested", clean_name: "Rotation project plan", experiment: rotation, person: jordan })),
};

const queued = label({ status: "needs_look", clean_name: null, confidence: 0.2 });

export const needsLookFiles = NeedsLookRows.parse([
  row({ c: "2", kind: "image", mime: "image/jpeg", preview: true, snippet: null, k: null, v: null, locations: [loc("/Lab/Gels/2026-11/IMG_4930.jpg", "2026-11-03T15:02:00Z")], label: queued }),
  row({
    c: "7",
    kind: "pdf",
    mime: "application/pdf",
    preview: false,
    snippet: "Run 14. Column temp 25 C. Flow 0.5 mL/min. Peak 1 at 11.2 min, peak 2 at 13.9 min. See notebook p. 41.",
    k: null,
    v: null,
    locations: [loc("/Lab/Scans/scan0042.pdf", "2026-11-02T18:40:00Z")],
    label: queued,
  }),
  row({ c: "8", kind: "spreadsheet", mime: "text/csv", preview: false, snippet: "A, B, C, D\n0.412, 0.398, 0.405, 0.611", k: null, v: null, locations: [loc("/Lab/Data/data (3).csv", "2026-11-01T09:12:00Z")], label: queued }),
  row({ c: "9", kind: "other", mime: "application/octet-stream", preview: false, snippet: null, k: null, v: null, locations: [loc("/Lab/Instruments/Nanodrop/export_0007.ndj", "2026-10-30T14:00:00Z")], label: queued }),
]);

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

export const disconnectedSource: SourceState = {
  kind: "disconnected",
  sourceId: SourceId.parse(source),
  accountLabel: "a.okafor@university.edu",
  rootPath: "/Lab",
  indexed: 1977,
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

// A lab folder tree: each entry is [direct files, subfolders]. Totals are summed below.
type Spec = [direct: number, children?: Record<string, Spec>];

const TREE: Spec = [
  3,
  {
    P450: [5, { batch1: [12], batch2: [9], batch3: [5, { raw: [14], gels: [6] }] }],
    "Thermal shift": [2, { "2026-09": [18], "2026-10": [22], analysis: [6] }],
    Protocols: [14, { Archive: [8] }],
    Crystallography: [1, { Screens: [24], Diffraction: [31], Models: [7] }],
    People: [0, { AO: [11], JM: [9], PN: [13] }],
    Shared: [2, { Instruments: [0, { "Plate reader": [40], AKTA: [16] }], Templates: [5] }],
  },
];

function treeRows(spec: Spec, path: string, parent: string | null): { rows: object[]; total: number } {
  const [direct, children = {}] = spec;
  const nested = Object.entries(children).map(([name, child]) => treeRows(child, path === "" ? name : `${path}/${name}`, path));
  const total = direct + nested.reduce((n, c) => n + c.total, 0);
  return { rows: [{ path, parent, direct_files: direct, total_files: total }, ...nested.flatMap((c) => c.rows)], total };
}

export const folderRows = FolderTreeRows.parse(treeRows(TREE, "", null).rows);

export const fixtureShell: ShellData = {
  labName: "Okafor Lab",
  memberCount: members.length,
  memberEmails: members.flatMap((m) => (m.email === null ? [] : [m.email])),
  isAdmin: true,
  email: "a.okafor@university.edu",
  folders: folderRows,
  needsLookCount: needsLookFiles.length,
  flagCount: 2,
  onboarding: fixtureOnboarding("quiet"),
};

const NAMED_FILES: Record<string, [name: string, kind: string, mime: string, size: number][]> = {
  "": [
    ["Lab inventory.xlsx", "spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 84_200],
    ["README.md", "text", "text/markdown", 3_100],
    ["Safety plan 2026.pdf", "pdf", "application/pdf", 1_240_000],
  ],
  P450: [
    ["Expression log.xlsx", "spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 126_000],
    ["P450 purification v3.pdf", "pdf", "application/pdf", 2_310_000],
    ["Plasmid map pET28-BM3.png", "image", "image/png", 412_000],
    ["Project summary.docx", "document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 58_400],
    ["primers.txt", "text", "text/plain", 1_900],
  ],
  "P450/batch3": [
    ["2026-10-14 SDS-PAGE.jpg", "image", "image/jpeg", 3_820_000],
    ["Batch 3 yields.xlsx", "spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 47_300],
    ["Nickel column notes.docx", "document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 31_000],
    ["SEC_trace_141026.csv", "spreadsheet", "text/csv", 268_000],
    ["final_v2_REAL.xlsx", "spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 182_000],
  ],
};

const GENERIC: [suffix: string, kind: string, mime: string][] = [
  [".csv", "spreadsheet", "text/csv"],
  [".pdf", "pdf", "application/pdf"],
  [".jpg", "image", "image/jpeg"],
  [".txt", "text", "text/plain"],
  [".docx", "document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
];

const hexOf = (text: string) =>
  Array.from({ length: 64 }, (_, i) => ((text.charCodeAt(i % text.length) * (i + 7)) % 16).toString(16)).join("");

export function folderFixtureFiles(path: FolderPath, offset: number): FileHit[] {
  const direct = folderRows.find((r) => r.path === path)?.directFiles ?? 0;
  const named = NAMED_FILES[path];
  const base = path === "" ? "" : `${path.split("/").at(-1)}`;
  const all = Array.from({ length: direct }, (_, i) => {
    const pick = named?.[i];
    const [suffix, kind, mime] = GENERIC[i % GENERIC.length] ?? GENERIC[0];
    const name = pick?.[0] ?? `${base.replace(/\s+/g, "_")}_${String(i + 1).padStart(2, "0")}${suffix}`;
    const day = String(28 - (i % 27)).padStart(2, "0");
    const full = `/Lab/${path === "" ? "" : `${path}/`}${name}`;
    return {
      sha256: hexOf(full),
      file_kind: pick?.[1] ?? kind,
      mime: pick?.[2] ?? mime,
      size: pick?.[3] ?? 20_000 + ((i * 7919) % 900_000),
      has_preview: false,
      snippet: null,
      locations: [loc(full, `2026-10-${day}T10:${String(i % 60).padStart(2, "0")}:00Z`)],
      label: null,
    };
  });
  return FolderFilesRows.parse(all.slice(offset, offset + FOLDER_PAGE_SIZE));
}
