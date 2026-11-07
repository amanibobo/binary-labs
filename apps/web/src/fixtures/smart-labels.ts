import { ExperimentRows, SearchFilesRows, type FileHit } from "@/lib/domain";
import { Sha256 } from "@/lib/ids";
import { experiments, people } from "./data";

// Dev-only screenshot data for smart labels: a HeLa drug A dose series whose plate 3 run failed
// (outer wells drifted), kept as 12 handwritten notebook pages grouped into one note, one page
// smudged; the plate 2 read before it and the plate 4 repeat after; and a voice note that left
// its experiment open. Imported only from *.dev.tsx pages and the fixture API.

const source = "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0004";
let n = 900;
const loc = (path: string, modified: string, kind: "upload" | "dropbox" = "upload") => ({
  id: `6f1c2c39-5a4e-4c55-9d7b-${String(++n).padStart(12, "0")}`,
  source_id: kind === "upload" ? source : "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003",
  source_kind: kind,
  path,
  original_name: path.slice(path.lastIndexOf("/") + 1),
  modified_at: modified,
});

const hela = { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ae004", name: "HeLa drug A" };
export const smartExperiments = ExperimentRows.parse([...experiments, { id: hela.id, name: hela.name, aliases: ["drug A"] }]);
const [ade] = people.map((p) => ({ id: p.id, name: p.name }));

// Page n's content hash: "70" then the page number, repeated.
export const pageSha = (page: number) => Sha256.parse(`7${page.toString(16)}`.repeat(32));

const ROLES = ["setup", "setup", "setup", "setup", "readings", "readings", "readings", "readings", "reflection", "reflection", "other", "other"] as const;

const pages = ROLES.map((role, i) => ({
  sha256: pageSha(i + 1),
  position: i + 1,
  role,
  has_preview: true,
  location: loc(`/Uploads/HeLa drug A/page_${String(i + 1).padStart(2, "0")}.jpg`, `2026-11-05T22:${String(2 + 2 * i).padStart(2, "0")}:00Z`),
}));

// What fixture previews each page shows: the real notebook photo, served by the media route.
export const NOTE_PAGE_PREVIEWS = new Map<string, string>(
  pages.map((p) => [p.sha256, `/dev/fixtures/media/note-page-${String(p.position).padStart(2, "0")}.webp`]),
);

const note = { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ad001", state: "suggested", reason: "Uploaded together", position: 1, pages };

const smart = {
  outcome: null,
  summary: null,
  conditions: [],
  note_kind: null,
  alternatives: [],
  unclear: [],
  follow_up: null,
  note: null,
};

export const smartFiles: FileHit[] = SearchFilesRows.parse([
  {
    sha256: pageSha(1),
    score: 0.05,
    keyword_rank: 1,
    vector_rank: 1,
    snippet: "Handwriting: Nov 3 2026 HeLa drug A dose series. Plate 3 (AB). Drug A: 0.1, 1, 10, 50, 100 uM, triplicate.",
    file_kind: "image",
    mime: "image/jpeg",
    size: 61_000,
    has_preview: true,
    locations: [pages[0].location],
    label: {
      ...smart,
      status: "check",
      clean_name: "HeLa drug A dose series, plate 3",
      date: "2026-11-03",
      experiment: hela,
      person: ade,
      instrument: null,
      tags: ["mtt", "ic50", "hela"],
      confidence: 0.78,
      outcome: "failed",
      summary: "Drug A dose series in HeLa on plate 3; the outer wells drifted, so the results are unreliable and the run is to be repeated.",
      note_kind: "experiment_notes",
      conditions: [
        { kind: "condition", what: "drug A", value: "0.1–100", unit: "µM" },
        { kind: "condition", what: "temperature", value: "37", unit: "°C" },
        { kind: "condition", what: "pre-incubation", value: "30", unit: "min" },
        { kind: "condition", what: "plate", value: "3", unit: null },
        { kind: "condition", what: "replicates", value: "triplicate", unit: null },
        { kind: "sample", what: "HeLa cells", value: "5000", unit: "cells/well" },
        { kind: "material", what: "MTT", value: "0.5", unit: "mg/mL" },
      ],
      alternatives: ["Drug A IC50 attempt, plate 3", "HeLa MTT notes, plate 3"],
      unclear: ["the 50 µM reading in well B6 on page 7 is smudged"],
      note,
    },
  },
  {
    sha256: "8b".repeat(32),
    score: 0.04,
    keyword_rank: 2,
    vector_rank: 2,
    snippet: "Software Version | 3.11.19\nPlate Number | Plate 2\nRead | A570\nWell | A570 (AU)",
    file_kind: "spreadsheet",
    mime: "text/csv",
    size: 9_000,
    has_preview: false,
    locations: [loc("/Lab/Instruments/Plate reader/plate2_A570.csv", "2026-10-30T21:05:00Z", "dropbox")],
    label: {
      ...smart,
      status: "suggested",
      clean_name: "HeLa drug A MTT read, plate 2",
      date: "2026-10-30",
      experiment: hela,
      person: ade,
      instrument: "Plate reader",
      tags: ["a570", "mtt"],
      confidence: 0.9,
      outcome: "worked",
      summary: "The plate 2 MTT read at 570 nm for the drug A dose series.",
      note_kind: "data",
      conditions: [
        { kind: "condition", what: "drug A", value: "0.1–100", unit: "µM" },
        { kind: "condition", what: "plate", value: "2", unit: null },
      ],
    },
  },
  {
    sha256: "8c".repeat(32),
    score: 0.03,
    keyword_rank: 3,
    vector_rank: 3,
    snippet: "Plate 4, repeat of the drug A dose series in HeLa with PBS in all outer wells. No edge drift this time. IC50 about 11 uM. This is the one to use.",
    file_kind: "text",
    mime: "text/plain",
    size: 1_200,
    has_preview: false,
    locations: [loc("/Lab/People/AO/plate4 notes.txt", "2026-11-08T20:10:00Z", "dropbox")],
    label: {
      ...smart,
      status: "suggested",
      clean_name: "HeLa drug A repeat with PBS edges, plate 4",
      date: "2026-11-06",
      experiment: hela,
      person: ade,
      instrument: null,
      tags: ["ic50", "repeat"],
      confidence: 0.92,
      outcome: "final",
      summary: "The plate 4 repeat with PBS in the outer wells: no edge drift, IC50 about 11 µM. Use this one.",
      note_kind: "experiment_notes",
      conditions: [
        { kind: "condition", what: "drug A", value: "0.1–100", unit: "µM" },
        { kind: "condition", what: "plate", value: "4", unit: null },
        { kind: "material", what: "PBS in outer wells", value: null, unit: null },
      ],
    },
  },
]);

// The voice note behind the talk-through fixture: it says "that thing from Tuesday", so its
// label asks which experiment.
export const VOICE_NOTE_SHA = Sha256.parse("8d".repeat(32));
export const voiceNote: FileHit = SearchFilesRows.parse([
  {
    sha256: VOICE_NOTE_SHA,
    score: 0,
    keyword_rank: null,
    vector_rank: null,
    snippet: "Okay, so this is about that thing from Tuesday, the lysis for the batch...",
    file_kind: "audio",
    mime: "audio/webm",
    size: 400_000,
    has_preview: false,
    locations: [loc("/Uploads/Talk-throughs/Talk-through 2026-11-04 14.03.22.weba", "2026-11-04T14:03:22Z")],
    label: {
      ...smart,
      status: "check",
      clean_name: "BM3 lysis talk-through",
      date: "2026-11-04",
      experiment: null,
      person: { id: people[1].id, name: people[1].name },
      instrument: null,
      tags: ["lysis", "sonication"],
      confidence: 0.7,
      note_kind: "protocol",
      follow_up: {
        field: "experiment",
        question: "Which experiment was “that thing from Tuesday”?",
        choices: experiments.map((e) => ({ label: e.name, value: e.id })),
      },
    },
  },
])[0];
