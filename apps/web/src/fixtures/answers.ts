import { SourceKey, type AnswerSentence, type AnswerSource, type AskEvent, type AskStep, type FileSource, type RecentQuestion, type SavedAnswer } from "@/lib/answers";
import { LocationId, ProtocolId, ProtocolVersionId, QuestionId, Sha256, SourceId, SuggestionId, UserId } from "@/lib/ids";
import type { LabelSuggestion, ProtocolEditSuggestion } from "@/lib/suggestions";
import { purification, purificationBody } from "./protocols";

// Dev-only answers and suggestions for the fixture pages and screenshots. Plain data, so
// server pages can read it; the canned API is in fixture-ask-api.tsx.

const sourceId = SourceId.parse("6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003");
const loc = (n: number, path: string, modifiedAt: string) => ({
  id: LocationId.parse(`6f1c2c39-5a4e-4c55-9d7b-${String(900 + n).padStart(12, "0")}`),
  sourceId,
  sourceKind: "dropbox" as const,
  path,
  originalName: path.slice(path.lastIndexOf("/") + 1),
  modifiedAt,
});

const file = (key: string, c: string, f: Omit<FileSource, "kind" | "key" | "sha256">): FileSource => ({
  kind: "file",
  key: SourceKey.parse(key),
  sha256: Sha256.parse(c.repeat(64)),
  ...f,
});

const yields = file("F1", "d", {
  fileKind: "spreadsheet",
  name: "Batch 3 yields",
  location: loc(1, "/Lab/Data/Batch 3/yields.xlsx", "2026-10-16T08:40:00Z"),
  excerpts: [],
  tables: [{ name: "Yields", columns: [{ id: "A", label: "Batch" }, { id: "B", label: "Pellet (g)" }, { id: "C", label: "Yield (mg)" }, { id: "D", label: "A418/A280" }], rows: 6 }],
});
const notes = file("F2", "e", {
  fileKind: "text",
  name: "Bench notes, Oct 14",
  location: loc(2, "/Lab/People/AO/notes 2026-10-14.txt", "2026-10-14T21:05:00Z"),
  excerpts: ["Batch 3: pooled fractions 9 to 11, A418/A280 0.46. Filtered the lysate through 0.45 um before the HisTrap again, it stopped the pressure alarm."],
  tables: [],
});
const gel = file("F3", "a", {
  fileKind: "image",
  name: "Batch 3 SDS-PAGE gel",
  location: loc(3, "/Lab/Gels/2026-10 Batch 3/IMG_4821.jpg", "2026-10-14T16:12:00Z"),
  excerpts: ["SDS-PAGE gel of P450 BM3 batch 3: one strong band near 119 kDa in lanes 3 to 5."],
  tables: [],
});
const sec = file("F4", "f", {
  fileKind: "spreadsheet",
  name: "SEC trace, Oct 14",
  location: loc(4, "/Lab/Instruments/AKTA/SEC_trace_141026.csv", "2026-10-14T13:20:00Z"),
  excerpts: [],
  tables: [],
});
const buffers = file("F5", "b", {
  fileKind: "pdf",
  name: "P450 BM3 purification protocol, v3",
  location: loc(5, "/Lab/Protocols/P450 purification v3.pdf", "2026-09-30T10:00:00Z"),
  excerpts: [],
  tables: [],
});
const protocolSource: AnswerSource = {
  kind: "protocol",
  key: "P1",
  protocolId: ProtocolId.parse(purification.protocolId),
  versionId: ProtocolVersionId.parse(purification.id),
  version: purification.version,
  protocolKind: "protocol",
  title: purification.title,
};

// What retrieval found for the yield question: five files and a protocol, three of the files
// cited. The closest files for a question with no answer are numbered from 1, as retrieval does.
export const answerSources: AnswerSource[] = [yields, notes, gel, sec, buffers, protocolSource];
export const closestSources: AnswerSource[] = [sec, buffers, notes].map((s, i) => ({ ...s, key: SourceKey.parse(`F${i + 1}`) }));

const cell = (row: number, column: string, value: string) => ({ table: "Yields", column, row, value });

export const answerSentences: AnswerSentence[] = [
  { text: "Batch 3 gave 4.2 mg of BM3 from a 50 mL pellet.", citations: [{ source: "F1", cell: cell(3, "Yield (mg)", "4.2") }] },
  {
    text: "The pooled fractions 9 to 11 had an A418/A280 of 0.46, above the 0.4 a good run needs.",
    citations: [
      { source: "F2", cell: null },
      { source: "P1", cell: null },
    ],
  },
  { text: "The gel shows one strong band near 119 kDa.", citations: [{ source: "F3", cell: null }] },
];

// The steps the server sends while it gathers these sources, in its order: the search, each
// file, each protocol, then each table read. The search goes out twice, running and then done.
export function retrievalSteps(query: string, sources: readonly AnswerSource[]): { running: AskStep; done: AskStep[] } {
  const files = sources.flatMap((s) => (s.kind === "file" ? [s] : []));
  const protocols = sources.flatMap((s) => (s.kind === "protocol" ? [s] : []));
  let id = 1;
  const reads: AskStep[] = [
    ...files.map((f): AskStep => ({ kind: "file", id: id++, source: f.key, name: f.name, fileKind: f.fileKind })),
    ...protocols.map((p): AskStep => ({ kind: "protocol", id: id++, source: p.key, title: p.title, version: p.version })),
    ...files.flatMap((f) =>
      f.tables.map((t): AskStep => ({ kind: "table", id: id++, source: f.key, sheet: t.name, rows: t.rows, cells: t.rows * t.columns.length })),
    ),
  ];
  return {
    running: { kind: "search", id: 0, query, found: null },
    done: [{ kind: "search", id: 0, query, found: { files: files.length, protocols: protocols.length, byMeaning: true } }, ...reads],
  };
}

export const writeStep = (sources: readonly AnswerSource[], cached: boolean): AskStep => ({ kind: "write", id: retrievalSteps("", sources).done.length, cached });

const answerId = QuestionId.parse("8a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001");
export const doneOf = (sentences: AnswerSentence[], outcome: "answered" | "not_found", cached = false): AskEvent => ({
  type: "done",
  questionId: answerId,
  outcome,
  answer: { sentences },
  cached,
  costUsd: 0.012,
  latencyMs: 3400,
});

const viewer = UserId.parse("00000000-0000-4000-8000-00000000000b");
export const fixtureViewer = viewer;

export const recentQuestions: RecentQuestion[] = [
  { id: answerId, question: "What was the yield of P450 batch 3?", outcome: "answered", askedBy: viewer, askedByEmail: "priya.n@university.edu", askedAt: "2026-11-05T14:20:00Z" },
  {
    id: QuestionId.parse("8a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0002"),
    question: "Which buffer did we use for the SEC run in October?",
    outcome: "not_found",
    askedBy: UserId.parse("00000000-0000-4000-8000-00000000000a"),
    askedByEmail: "a.okafor@university.edu",
    askedAt: "2026-11-04T10:02:00Z",
  },
  {
    id: QuestionId.parse("8a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003"),
    question: "How long do we spin the lysate after sonication?",
    outcome: "answered",
    askedBy: UserId.parse("00000000-0000-4000-8000-00000000000c"),
    askedByEmail: "j.morales@university.edu",
    askedAt: "2026-11-03T16:45:00Z",
  },
  {
    id: QuestionId.parse("8a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0004"),
    question: "Which plate reader files are from the solubility screen?",
    outcome: "answered",
    askedBy: viewer,
    askedByEmail: "priya.n@university.edu",
    askedAt: "2026-11-03T11:10:00Z",
  },
  {
    id: QuestionId.parse("8a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0005"),
    question: "What temperature was plate 7 read at?",
    outcome: "not_found",
    askedBy: viewer,
    askedByEmail: "priya.n@university.edu",
    askedAt: "2026-11-02T09:30:00Z",
  },
  {
    id: QuestionId.parse("8a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0006"),
    question: "Where is the Bradford standard curve from Oct 30?",
    outcome: "answered",
    askedBy: UserId.parse("00000000-0000-4000-8000-00000000000a"),
    askedByEmail: "a.okafor@university.edu",
    askedAt: "2026-10-31T15:00:00Z",
  },
  ...[
    ["What concentration of imidazole elutes BM3 from the nickel column?", "answered", "2026-10-30T10:20:00Z"],
    ["Which gel shows batch 2 after the SEC column?", "answered", "2026-10-29T16:05:00Z"],
    ["Did anyone run a thermal shift on the A82F variant?", "not_found", "2026-10-28T13:40:00Z"],
    ["What was the A420/A280 ratio for batch 1?", "answered", "2026-10-27T09:15:00Z"],
    ["Where are the ELISA plate layouts from October?", "answered", "2026-10-24T14:30:00Z"],
    ["How much lysozyme goes into the lysis buffer?", "answered", "2026-10-22T11:00:00Z"],
  ].map(
    ([question, outcome, askedAt], i): RecentQuestion => ({
      id: QuestionId.parse(`8a1c2c39-5a4e-4c55-9d7b-0c3c1a7a00${String(i + 7).padStart(2, "0")}`),
      question,
      outcome: outcome === "not_found" ? "not_found" : "answered",
      askedBy: i % 2 === 0 ? viewer : UserId.parse("00000000-0000-4000-8000-00000000000c"),
      askedByEmail: i % 2 === 0 ? "priya.n@university.edu" : "j.morales@university.edu",
      askedAt,
    }),
  ),
];

export const savedAnswer: SavedAnswer = {
  id: answerId,
  question: "What was the yield of P450 batch 3?",
  outcome: "answered",
  answer: { sentences: answerSentences },
  sources: answerSources,
  steps: [...retrievalSteps("What was the yield of P450 batch 3?", answerSources).done, writeStep(answerSources, false)],
  askedAt: "2026-11-05T14:20:00Z",
  myVerdict: null,
};

const draftBody = purificationBody.replace(
  "3. Spin the lysate at 15,000 g for 30 min at 4 °C. Keep the supernatant.\n4. Load the supernatant",
  "3. Spin the lysate at 15,000 g for 30 min at 4 °C. Keep the supernatant.\n4. Filter the supernatant through a 0.45 µm filter, so the column doesn't clog.\n5. Load the filtered supernatant",
).replace("5. Wash with 10 column volumes", "6. Wash with 10 column volumes").replace("6. Run fractions on an SDS-PAGE gel", "7. Run fractions on an SDS-PAGE gel");

export const protocolEdit: ProtocolEditSuggestion = {
  kind: "protocol_edit",
  id: SuggestionId.parse("9a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001"),
  questionId: answerId,
  summary: "Adds the 0.45 µm filter step that the batch 3 and batch 4 notes both do before the HisTrap column.",
  sources: [notes, file("F3", "c", { fileKind: "text", name: "Batch 4 notes", location: loc(6, "/Uploads/P450 BM3/Batch 4 notes.txt", "2026-11-03T21:20:41Z"), excerpts: ["Filtered 0.45 um before loading, no pressure alarm this time."], tables: [] })],
  requestedBy: viewer,
  createdAt: "2026-11-05T14:24:00Z",
  decision: { state: "open", decidedBy: null, decidedAt: null },
  protocolId: purification.protocolId,
  baseVersionId: purification.id,
  baseVersion: purification.version,
  before: { title: purification.title, body: purificationBody },
  draft: { title: purification.title, body: draftBody, note: "Filter before the column" },
  stale: false,
  appliedVersion: null,
};

export const labelFixes: LabelSuggestion = {
  kind: "labels",
  id: SuggestionId.parse("9a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0002"),
  questionId: answerId,
  summary: "These 4 files are from P450 BM3 batch 3 but have no experiment on their label.",
  sources: [],
  requestedBy: viewer,
  createdAt: "2026-11-05T14:26:00Z",
  decision: { state: "open", decidedBy: null, decidedAt: null },
  changes: [
    {
      sha256: Sha256.parse("e".repeat(64)),
      path: "/Lab/People/AO/notes 2026-10-14.txt",
      current: { cleanName: "Bench notes, Oct 14", date: "2026-10-14", experiment: null, person: "Ade Okafor" },
      proposed: { cleanName: null, date: null, experiment: "P450 BM3", person: null },
      reason: "The notes are about batch 3's nickel column and its fractions.",
      applied: false,
    },
    {
      sha256: Sha256.parse("f".repeat(64)),
      path: "/Lab/Instruments/AKTA/SEC_trace_141026.csv",
      current: { cleanName: "SEC trace, Oct 14", date: "2026-10-14", experiment: null, person: null },
      proposed: { cleanName: null, date: null, experiment: "P450 BM3", person: "Ade Okafor" },
      reason: "Run the same day as the batch 3 notes, which mention the SEC run.",
      applied: false,
    },
    {
      sha256: Sha256.parse("2".repeat(64)),
      path: "/Lab/Gels/2026-10 Batch 3/IMG_4822.jpg",
      current: { cleanName: "Gel photo", date: null, experiment: null, person: null },
      proposed: { cleanName: "Batch 3 SDS-PAGE gel, second lane set", date: "2026-10-14", experiment: "P450 BM3", person: null },
      reason: "It sits in the Batch 3 gels folder beside IMG_4821, taken the same afternoon.",
      applied: false,
    },
    {
      sha256: Sha256.parse("9".repeat(64)),
      path: "/Lab/Data/Batch 3/fractions.csv",
      current: { cleanName: "Fraction absorbances", date: "2026-10-14", experiment: null, person: null },
      proposed: { cleanName: null, date: null, experiment: "P450 BM3", person: null },
      reason: "It's in the Batch 3 data folder and lists fractions 8 to 12.",
      applied: false,
    },
  ],
};
