import { describe, expect, it } from "vitest";
import { LabelRow, LabelWire, NoteId, PLAIN_LABEL, type FileHit, type Label, type NoteInfo } from "../domain";
import { ExperimentId, LabId, LocationId, PersonId, Sha256, SourceId } from "../ids";
import { applyEdit, optimisticLabel, type EditResult, type LabLists } from "../label-edit";
import { correctLabelArgs, correctRequest } from "../labels";
import { collapseNotes, missingCovers, noteFailure, noteRpc, NoteRequest, openingPage, pageCaption, withoutPage } from "../notes";
import { conditionText, outcomeWord, pageCount } from "../row-summary";
import { parseUploadHeaders, uploadHeaders } from "../uploads";

const hela = { id: ExperimentId.parse("00000000-0000-4000-8000-0000000000e4"), name: "HeLa drug A" };
const bm3 = { id: ExperimentId.parse("00000000-0000-4000-8000-0000000000e1"), name: "P450 BM3" };
const ade = { id: PersonId.parse("00000000-0000-4000-8000-0000000000a2"), name: "Ade Okafor" };
const lists: LabLists = { experiments: [{ ...hela, aliases: ["drug A"] }, { ...bm3, aliases: [] }], people: [{ ...ade, aliases: [] }] };
const sha = (c: string) => Sha256.parse(c.repeat(64));

const plate3: Label = {
  ...PLAIN_LABEL,
  status: "check",
  cleanName: "HeLa drug A dose series, plate 3",
  date: "2026-11-03",
  experiment: hela,
  person: ade,
  instrument: null,
  tags: ["mtt"],
  confidence: 0.78,
  outcome: "failed",
  summary: "Outer wells drifted, so the results are unreliable.",
  noteKind: "experiment_notes",
  conditions: [
    { kind: "condition", what: "drug A", value: "0.1–100", unit: "µM" },
    { kind: "condition", what: "temperature", value: "37", unit: "°C" },
    { kind: "condition", what: "50 µM well B6 reading", value: "[unclear]", unit: null },
  ],
  alternatives: ["Drug A IC50 attempt, plate 3", "HeLa MTT notes, plate 3"],
  unclear: ["the 50 µM reading in well B6 on page 7 is smudged"],
};

function changed(result: EditResult) {
  if (result.kind !== "changed") throw new Error(`expected a change, got ${JSON.stringify(result)}`);
  return result.draft;
}

describe("the label's new fields", () => {
  const row = {
    status: "check",
    clean_name: "HeLa drug A dose series, plate 3",
    date: "2026-11-03",
    experiment: hela,
    person: null,
    instrument: null,
    tags: [],
    confidence: 0.78,
    outcome: "failed",
    summary: "Outer wells drifted.",
    conditions: [{ kind: "condition", what: "drug A", value: "0.1–100", unit: "µM" }],
    note_kind: "experiment_notes",
    alternatives: ["Drug A IC50 attempt, plate 3"],
    unclear: ["the 50 µM reading is smudged"],
    follow_up: null,
    note: {
      id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ad001",
      state: "suggested",
      reason: "Uploaded together",
      position: 1,
      pages: [1, 2].map((p) => ({
        sha256: sha(String(p)),
        position: p,
        role: p === 1 ? "setup" : "readings",
        has_preview: true,
        location: null,
      })),
    },
  };

  it("read from label_json, and survive the trip to the browser", () => {
    const label = LabelRow.parse(row);
    expect(label).toMatchObject({ outcome: "failed", noteKind: "experiment_notes", summary: "Outer wells drifted." });
    expect(label.note?.pages.map((p) => [p.position, p.role, p.hasPreview])).toEqual([
      [1, "setup", true],
      [2, "readings", true],
    ]);
    expect(LabelWire.parse(JSON.parse(JSON.stringify(label)))).toEqual(label);
  });

  it("default to empty for a label from before them", () => {
    const { outcome, summary, conditions, note_kind, alternatives, unclear, follow_up, note, ...old } = row;
    expect([outcome, summary, conditions, note_kind, alternatives, unclear, follow_up, note]).toHaveLength(8);
    expect(LabelRow.parse(old)).toMatchObject(PLAIN_LABEL);
  });

  it("refuse an outcome or a condition the database wouldn't hold", () => {
    expect(LabelRow.safeParse({ ...row, outcome: "great" }).success).toBe(false);
    expect(LabelRow.safeParse({ ...row, conditions: [{ kind: "mood", what: "x", value: null, unit: null }] }).success).toBe(false);
  });
});

describe("editing the new fields", () => {
  it("sets the outcome, or not a run", () => {
    expect(changed(applyEdit({ label: plate3, edit: { kind: "outcome", outcome: "repeat" }, lists })).outcome).toBe("repeat");
    expect(changed(applyEdit({ label: plate3, edit: { kind: "outcome", outcome: null }, lists })).outcome).toBeNull();
    expect(applyEdit({ label: plate3, edit: { kind: "outcome", outcome: "failed" }, lists }).kind).toBe("unchanged");
  });

  it("trims the summary and clears it when emptied", () => {
    expect(changed(applyEdit({ label: plate3, edit: { kind: "summary", text: "  Redo it  with PBS edges " }, lists })).summary).toBe(
      "Redo it with PBS edges",
    );
    expect(changed(applyEdit({ label: plate3, edit: { kind: "summary", text: " " }, lists })).summary).toBeNull();
    expect(applyEdit({ label: plate3, edit: { kind: "summary", text: "x".repeat(401) }, lists }).kind).toBe("invalid");
  });

  it("fills in an unclear value, drops a retyped unit, and takes a condition off when emptied", () => {
    const filled = changed(applyEdit({ label: plate3, edit: { kind: "condition", index: 2, text: "0.38" }, lists }));
    expect(filled.conditions[2]).toEqual({ kind: "condition", what: "50 µM well B6 reading", value: "0.38", unit: null });
    const unit = changed(applyEdit({ label: plate3, edit: { kind: "condition", index: 0, text: "0.1–50 µM" }, lists }));
    expect(unit.conditions[0]?.value).toBe("0.1–50");
    const removed = changed(applyEdit({ label: plate3, edit: { kind: "condition", index: 1, text: "" }, lists }));
    expect(removed.conditions.map((c) => c.what)).toEqual(["drug A", "50 µM well B6 reading"]);
    expect(applyEdit({ label: plate3, edit: { kind: "condition", index: 9, text: "1" }, lists }).kind).toBe("invalid");
  });

  it("sets the kind of file", () => {
    expect(changed(applyEdit({ label: plate3, edit: { kind: "noteKind", noteKind: "data" }, lists })).noteKind).toBe("data");
  });

  it("answers a voice note's question with an experiment or a day", () => {
    const voice: Label = { ...plate3, experiment: null, date: null, followUp: { field: "experiment", question: "Which?", choices: [{ label: "P450 BM3", value: bm3.id }] } };
    const answered = changed(applyEdit({ label: voice, edit: { kind: "answer", field: "experiment", value: bm3.id }, lists }));
    expect(answered.experiment).toEqual(bm3);
    expect(optimisticLabel(voice, answered).followUp).toBeNull();
    const day = changed(applyEdit({ label: voice, edit: { kind: "answer", field: "date", value: "2026-11-03" }, lists }));
    expect(day.date).toBe("2026-11-03");
    // Answering the date leaves the experiment question standing.
    expect(optimisticLabel(voice, day).followUp).not.toBeNull();
    expect(applyEdit({ label: voice, edit: { kind: "answer", field: "experiment", value: "nope" }, lists }).kind).toBe("invalid");
  });

  it("predicts what the database stores: a person's change settles Binary's doubts", () => {
    const renamed = changed(applyEdit({ label: plate3, edit: { kind: "rename", text: plate3.alternatives[0] ?? "" }, lists }));
    const shown = optimisticLabel(plate3, renamed);
    expect(shown).toMatchObject({ status: "corrected", cleanName: "Drug A IC50 attempt, plate 3", alternatives: [], unclear: [] });
    expect(shown.conditions).toEqual(plate3.conditions);
  });

  it("sends every new field to correct_label in p_more", () => {
    const draft = changed(applyEdit({ label: plate3, edit: { kind: "outcome", outcome: "repeat" }, lists }));
    const args = correctLabelArgs(LabId.parse("00000000-0000-4000-8000-00000000000a"), correctRequest(sha("a"), draft));
    expect(args.p_more).toEqual({ outcome: "repeat", summary: plate3.summary, conditions: plate3.conditions, note_kind: "experiment_notes" });
  });
});

describe("the closed row", () => {
  it("says the outcome in one word, a problem only when it failed", () => {
    expect(outcomeWord(plate3)).toEqual({ text: "failed", problem: true });
    expect(outcomeWord({ ...plate3, outcome: "final" })).toEqual({ text: "final", problem: false });
    expect(outcomeWord({ ...plate3, outcome: null })).toBeNull();
    expect(outcomeWord(null)).toBeNull();
  });

  it("reads a condition as a person would, and never shows a guessed number", () => {
    expect(plate3.conditions.map(conditionText)).toEqual(["drug A 0.1–100 µM", "37 °C", "50 µM well B6 reading: not clear"]);
  });

  it("counts a note's pages", () => {
    expect(pageCount(plate3)).toBeNull();
    expect(pageCount({ ...plate3, note: note(12) })).toBe("12 pages");
  });
});

function note(pages: number): NoteInfo {
  const all = Array.from({ length: pages }, (_, i) => ({
    sha256: sha((i + 1).toString(16).slice(-1)),
    position: i + 1,
    role: i < 4 ? ("setup" as const) : i < 8 ? ("readings" as const) : ("other" as const),
    hasPreview: true,
    location: null,
  }));
  const [first, ...rest] = all;
  if (first === undefined) throw new Error("a note has pages");
  return { id: NoteId.parse("6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ad001"), state: "suggested", reason: "Uploaded together", position: 1, pages: [first, ...rest] };
}

const hit = (s: Sha256, label: Label | null): FileHit => ({
  sha256: s,
  fileKind: "image",
  mime: "image/jpeg",
  size: 1,
  hasPreview: true,
  snippet: null,
  locations: [{ id: LocationId.parse("6f1c2c39-5a4e-4c55-9d7b-000000000001"), sourceId: SourceId.parse("6f1c2c39-5a4e-4c55-9d7b-000000000002"), sourceKind: "upload", path: "/x", originalName: "x", modifiedAt: "2026-11-05T00:00:00Z" }],
  matchedBy: [],
  label,
});

describe("notes", () => {
  const n = note(3);
  const [p1, p2, p3] = n.pages;

  it("open at the page a search matched, else the first", () => {
    expect(openingPage(n, 3).position).toBe(3);
    expect(openingPage(n, null).position).toBe(1);
    expect(openingPage(n, 9).position).toBe(1);
    expect(pageCaption(n, openingPage(n, 2))).toBe("Page 2 of 3 · Setup");
  });

  it("show once in a list, as their first page, fetched when the list lacks it", () => {
    const page2 = hit(p2?.sha256 ?? sha("0"), { ...plate3, note: { ...n, position: 2 } });
    const page3 = hit(p3?.sha256 ?? sha("0"), { ...plate3, note: { ...n, position: 3 } });
    const lone = hit(sha("f"), plate3);
    expect(missingCovers([page2, lone, page3])).toEqual([p1?.sha256]);
    const cover = hit(p1?.sha256 ?? sha("0"), { ...plate3, note: n });
    expect(collapseNotes([page2, lone, page3], [cover]).map((h) => h.sha256)).toEqual([p1?.sha256, sha("f")]);
    expect(collapseNotes([page2, lone], []).map((h) => h.sha256)).toEqual([p2?.sha256, sha("f")]);
  });

  it("lose a page with the rest moving up, and split when one is left", () => {
    expect(withoutPage(n, p1?.sha256 ?? sha("0"))?.pages.map((p) => [p.sha256, p.position])).toEqual([
      [p2?.sha256, 1],
      [p3?.sha256, 2],
    ]);
    expect(withoutPage(note(2), sha("1"))).toBeNull();
  });

  it("map each change to its database function and its errors to plain words", () => {
    const lab = LabId.parse("00000000-0000-4000-8000-00000000000a");
    expect(noteRpc(lab, NoteRequest.parse({ action: "split", noteId: n.id }))).toEqual({ fn: "split_note", args: { p_note_id: n.id } });
    expect(noteRpc(lab, NoteRequest.parse({ action: "join", shas: [sha("a"), sha("b")] })).fn).toBe("join_note");
    expect(NoteRequest.safeParse({ action: "join", shas: [sha("a")] }).success).toBe(false);
    expect(noteFailure({ code: "BL703" }).status).toBe(409);
    expect(noteFailure({ code: "XX000" })).toEqual({ status: 500, message: "We couldn't change that note. Try again." });
  });
});

describe("upload batches", () => {
  it("ride a header and come back, or stay absent", () => {
    const meta = { name: "page_01.jpg", experiment: null, uploadedOn: "2026-11-05", modifiedAt: null };
    const batch = "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0b01";
    expect(parseUploadHeaders(new Headers(uploadHeaders({ ...meta, batch })))?.batch).toBe(batch);
    expect(parseUploadHeaders(new Headers(uploadHeaders(meta)))?.batch).toBeNull();
  });
});
