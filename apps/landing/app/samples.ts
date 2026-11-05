// Sample files for the landing demos. Made up, but shaped like a real lab's Dropbox.
export type Kind = "image" | "spreadsheet" | "pdf" | "document";
export type Preview = "gel" | "plate" | "protocol" | "notebook";

export type SampleFile = {
  clean: string;
  original: string;
  folder: string;
  kind: Kind;
  tags: readonly string[];
  preview: Preview;
  places?: number;
};

export const FILES = {
  gelOct12: {
    clean: "2026-10-12 P450 gel, batch 3",
    original: "IMG_4821.jpg",
    folder: "Maya/phone uploads",
    kind: "image",
    tags: ["P450", "gel", "batch 3", "Maya"],
    preview: "gel",
  },
  gelOct14: {
    clean: "2026-10-14 P450 gel, batch 3, rerun",
    original: "gel2 final.tif",
    folder: "Gels/2026",
    kind: "image",
    tags: ["P450", "gel", "batch 3", "rerun"],
    preview: "gel",
  },
  expressionNotes: {
    clean: "Batch 3 expression notes",
    original: "notes_oct.docx",
    folder: "Maya/notes",
    kind: "document",
    tags: ["P450", "batch 3", "expression"],
    preview: "notebook",
  },
  bradfordProtocol: {
    clean: "Bradford assay, protocol v4",
    original: "bradford_FINAL(2).pdf",
    folder: "Protocols",
    kind: "pdf",
    tags: ["Bradford", "protocol", "assay", "standard curve"],
    preview: "protocol",
    places: 4,
  },
  bradfordPlate: {
    clean: "2026-09-30 Bradford plate, standard curve",
    original: "plate_reader_0930.xlsx",
    folder: "Instruments/plate reader",
    kind: "spreadsheet",
    tags: ["Bradford", "plate", "standard curve"],
    preview: "plate",
  },
  thermalShift: {
    clean: "2026-08-21 Thermal shift, all constructs",
    original: "final_v2_REAL.xlsx",
    folder: "Jun/old laptop",
    kind: "spreadsheet",
    tags: ["thermal shift", "melt curve", "constructs"],
    preview: "plate",
  },
  lysisNotebook: {
    clean: "Notebook p. 42, lysis buffer",
    original: "IMG_3310.jpg",
    folder: "Scans",
    kind: "image",
    tags: ["notebook", "lysis buffer", "recipe"],
    preview: "notebook",
  },
  sdsProtocol: {
    clean: "SDS-PAGE, protocol v2",
    original: "sds page how to.docx",
    folder: "Protocols",
    kind: "document",
    tags: ["SDS-PAGE", "gel", "protocol"],
    preview: "protocol",
  },
} as const satisfies Record<string, SampleFile>;

export type FileId = keyof typeof FILES;
export type Hit = { id: FileId; why: string };

// What the demo types, and what comes back, in order.
export const DEMO_SCRIPT: readonly { query: string; hits: readonly Hit[] }[] = [
  {
    query: "P450 gels from batch 3",
    hits: [
      { id: "gelOct12", why: "Text in the photo: “P450 b3”" },
      { id: "gelOct14", why: "Same lanes as the Oct 12 gel" },
      { id: "expressionNotes", why: "“the batch 3 gel looked clean”" },
    ],
  },
  {
    query: "bradford standard curve",
    hits: [
      { id: "bradfordPlate", why: "Sheet “std curve”, 8 standards" },
      { id: "bradfordProtocol", why: "Step 3, the standard curve" },
    ],
  },
  {
    query: "final_v2_REAL.xlsx",
    hits: [{ id: "thermalShift", why: "File name" }],
  },
];

const FIELDS = [
  ["name", (f: SampleFile) => f.clean],
  ["file name", (f: SampleFile) => f.original],
  ["labels", (f: SampleFile) => f.tags.join(" ")],
  ["folder", (f: SampleFile) => f.folder],
] as const;

// A small stand-in for the real search: every word must appear somewhere in the file's record.
export function searchSamples(query: string): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/s$/, ""));
  if (words.length === 0) return [];
  const hits: Hit[] = [];
  for (const [id, file] of Object.entries(FILES) as [FileId, SampleFile][]) {
    const found = words.map((w) => FIELDS.find(([, read]) => read(file).toLowerCase().includes(w)));
    if (found.some((f) => f === undefined)) continue;
    const field = found[0]?.[0] ?? "name";
    hits.push({ id, why: `Matched in its ${field}` });
  }
  return hits;
}
