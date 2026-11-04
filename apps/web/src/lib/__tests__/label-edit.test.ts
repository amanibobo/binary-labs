import { describe, expect, it } from "vitest";
import type { Experiment, Label, Person } from "../domain";
import { CorrectionId, ExperimentId, PersonId, Sha256 } from "../ids";
import {
  applyEdit,
  matchByName,
  needsLookDelta,
  optimisticLabel,
  parseDate,
  revertTarget,
  undoTarget,
  type EditResult,
  type LabLists,
} from "../label-edit";

const bm3: Experiment = { id: ExperimentId.parse("00000000-0000-4000-8000-0000000000e1"), name: "P450 BM3", aliases: ["BM3", "CYP102A1"] };
const variants: Experiment = { id: ExperimentId.parse("00000000-0000-4000-8000-0000000000e2"), name: "BM3", aliases: ["variants"] };
const screen: Experiment = { id: ExperimentId.parse("00000000-0000-4000-8000-0000000000e3"), name: "Solubility screen", aliases: ["sol"] };
const priya: Person = { id: PersonId.parse("00000000-0000-4000-8000-0000000000a1"), name: "Priya Nair", aliases: ["PN", "priya"] };
const ade: Person = { id: PersonId.parse("00000000-0000-4000-8000-0000000000a2"), name: "Ade Okafor", aliases: ["AO"] };
const lists: LabLists = { experiments: [bm3, variants, screen], people: [priya, ade] };

const label: Label = {
  status: "suggested",
  cleanName: "Batch 3 gel",
  date: "2026-10-14",
  experiment: null,
  person: { id: ade.id, name: ade.name },
  instrument: "ChemiDoc",
  tags: ["batch 3"],
  confidence: 0.8,
};
const queued: Label = { ...label, status: "needs_look", cleanName: null };

function draft(result: EditResult) {
  if (result.kind !== "changed") throw new Error(`expected a change, got ${JSON.stringify(result)}`);
  return result.draft;
}

describe("parseDate", () => {
  it("reads the three accepted forms as the same day", () => {
    for (const text of ["2026-10-14", "Oct 14 2026", "14 Oct 2026", "October 14th, 2026", " oct  14 2026 "]) {
      expect(parseDate(text)).toEqual({ kind: "date", date: "2026-10-14" });
    }
  });

  it("keeps day and month apart when both could be small numbers", () => {
    expect(parseDate("3 Feb 2026")).toEqual({ kind: "date", date: "2026-02-03" });
    expect(parseDate("Feb 3 2026")).toEqual({ kind: "date", date: "2026-02-03" });
    expect(parseDate("2026-02-03")).toEqual({ kind: "date", date: "2026-02-03" });
  });

  it("clears on empty and rejects dates that don't exist or are ambiguous", () => {
    expect(parseDate("  ")).toEqual({ kind: "date", date: null });
    for (const text of ["2026-02-30", "Feb 30 2026", "14/10/2026", "10/14/2026", "Ju 4 2026", "Oct 2026", "yesterday"]) {
      expect(parseDate(text).kind, text).toBe("invalid");
    }
  });
});

describe("matchByName", () => {
  it("finds the experiment an alias belongs to, by whole name only", () => {
    expect(matchByName("cyp102a1", lists.experiments)).toEqual({ kind: "found", item: bm3 });
    expect(matchByName("SOL", lists.experiments)).toEqual({ kind: "found", item: screen });
    expect(matchByName("P450", lists.experiments)).toEqual({ kind: "none" });
  });

  it("prefers an exact name over another experiment's alias", () => {
    expect(matchByName("bm3", lists.experiments)).toEqual({ kind: "found", item: variants });
  });

  it("reports aliases shared by two entries instead of guessing", () => {
    const twins = [bm3, { ...screen, aliases: ["cyp102a1"] }];
    expect(matchByName("CYP102A1", twins)).toEqual({ kind: "ambiguous", names: ["P450 BM3", "Solubility screen"] });
  });
});

describe("applyEdit", () => {
  it("renames, trimming, and leaves every tag as it was", () => {
    expect(draft(applyEdit({ label, edit: { kind: "rename", text: "  Batch 3  SDS-PAGE " }, lists }))).toEqual({
      cleanName: "Batch 3 SDS-PAGE",
      date: "2026-10-14",
      experiment: null,
      person: { id: ade.id, name: "Ade Okafor" },
      instrument: "ChemiDoc",
      tags: ["batch 3"],
    });
  });

  it("refuses an empty name and reports an unchanged one", () => {
    expect(applyEdit({ label, edit: { kind: "rename", text: "   " }, lists })).toEqual({ kind: "invalid", message: "A label needs a name." });
    expect(applyEdit({ label: queued, edit: { kind: "rename", text: "" }, lists }).kind).toBe("invalid");
    expect(applyEdit({ label, edit: { kind: "rename", text: "Batch 3 gel" }, lists })).toEqual({ kind: "unchanged" });
  });

  it("sets the experiment and person by name or alias, case-insensitively", () => {
    const withExperiment = draft(applyEdit({ label, edit: { kind: "set", tag: { kind: "experiment" }, text: "cyp102a1" }, lists }));
    expect(withExperiment.experiment).toEqual({ id: bm3.id, name: "P450 BM3" });
    const withPerson = draft(applyEdit({ label, edit: { kind: "set", tag: { kind: "person" }, text: "pn" }, lists }));
    expect(withPerson.person).toEqual({ id: priya.id, name: "Priya Nair" });
  });

  it("saves nothing for an unknown experiment or person", () => {
    expect(applyEdit({ label, edit: { kind: "set", tag: { kind: "experiment" }, text: "P450" }, lists })).toEqual({
      kind: "invalid",
      message: "No experiment called “P450”. Add it in Settings first.",
    });
    expect(applyEdit({ label, edit: { kind: "set", tag: { kind: "person" }, text: "JM" }, lists }).kind).toBe("invalid");
  });

  it("edits the date in any accepted form and clears it when emptied or removed", () => {
    expect(draft(applyEdit({ label, edit: { kind: "set", tag: { kind: "date" }, text: "2 Nov 2026" }, lists })).date).toBe("2026-11-02");
    expect(draft(applyEdit({ label, edit: { kind: "set", tag: { kind: "date" }, text: "" }, lists })).date).toBeNull();
    expect(draft(applyEdit({ label, edit: { kind: "remove", tag: { kind: "date" } }, lists })).date).toBeNull();
    expect(applyEdit({ label, edit: { kind: "set", tag: { kind: "date" }, text: "11/02/2026" }, lists }).kind).toBe("invalid");
  });

  it("edits and removes free tags by position", () => {
    const two = { ...label, tags: ["batch 3", "rerun"] };
    expect(draft(applyEdit({ label: two, edit: { kind: "set", tag: { kind: "free", index: 1 }, text: "lane 6" }, lists })).tags).toEqual([
      "batch 3",
      "lane 6",
    ]);
    expect(draft(applyEdit({ label: two, edit: { kind: "remove", tag: { kind: "free", index: 0 } }, lists })).tags).toEqual(["rerun"]);
    expect(draft(applyEdit({ label, edit: { kind: "remove", tag: { kind: "instrument" } }, lists })).instrument).toBeNull();
  });

  it("adds a tag into an empty slot it names, else as a free tag", () => {
    expect(draft(applyEdit({ label, edit: { kind: "add", text: "bm3" }, lists })).experiment).toEqual({ id: variants.id, name: "BM3" });
    // The person slot is taken, so Priya's initials stay a plain tag.
    expect(draft(applyEdit({ label, edit: { kind: "add", text: "PN" }, lists }))).toMatchObject({
      person: { id: ade.id },
      tags: ["batch 3", "PN"],
    });
    expect(draft(applyEdit({ label: { ...label, date: null }, edit: { kind: "add", text: "Oct 9 2026" }, lists })).date).toBe("2026-10-09");
    expect(applyEdit({ label, edit: { kind: "add", text: " batch 3 " }, lists })).toEqual({ kind: "unchanged" });
  });

  it("only lets a needs-a-look file be named", () => {
    expect(draft(applyEdit({ label: queued, edit: { kind: "rename", text: "Plate 7 absorbance" }, lists })).cleanName).toBe(
      "Plate 7 absorbance",
    );
    expect(applyEdit({ label: queued, edit: { kind: "add", text: "plate" }, lists }).kind).toBe("invalid");
  });
});

describe("optimisticLabel", () => {
  it("predicts accepted for the same values and corrected otherwise, as the database does", () => {
    const same = draft(applyEdit({ label: { ...label, cleanName: "x" }, edit: { kind: "rename", text: "Batch 3 gel" }, lists }));
    expect(optimisticLabel(label, same)).toMatchObject({ status: "accepted", confidence: 1, cleanName: "Batch 3 gel" });
    const renamed = draft(applyEdit({ label, edit: { kind: "rename", text: "Gel" }, lists }));
    expect(optimisticLabel(label, renamed)).toMatchObject({ status: "corrected", cleanName: "Gel" });
    expect(optimisticLabel(queued, renamed).status).toBe("corrected");
  });
});

describe("undo bookkeeping", () => {
  const sha = Sha256.parse("a".repeat(64));
  const first: Label = { ...label, status: "corrected", cleanName: "First", confidence: 1 };
  const second: Label = { ...first, cleanName: "Second" };
  const undoFirst = { correctionId: CorrectionId.parse(1), sha256: sha, before: label, after: first };
  const undoSecond = { correctionId: CorrectionId.parse(2), sha256: sha, before: first, after: second };

  it("restores the label each correction replaced", () => {
    expect(undoTarget(undoSecond, second)).toEqual(first);
    expect(undoTarget(undoFirst, first)).toEqual(label);
  });

  it("won't undo a correction a later edit has replaced", () => {
    expect(undoTarget(undoFirst, second)).toBeNull();
    expect(undoTarget(undoFirst, null)).toBeNull();
  });

  it("reverts a failed save only while its result is still on screen", () => {
    expect(revertTarget({ showing: first, optimistic: first, before: label })).toEqual(label);
    expect(revertTarget({ showing: second, optimistic: first, before: label })).toBeNull();
  });

  it("counts files entering and leaving Needs a look", () => {
    expect(needsLookDelta(queued, first)).toBe(-1);
    expect(needsLookDelta(first, queued)).toBe(1);
    expect(needsLookDelta(null, queued)).toBe(1);
    expect(needsLookDelta(label, first)).toBe(0);
  });
});
