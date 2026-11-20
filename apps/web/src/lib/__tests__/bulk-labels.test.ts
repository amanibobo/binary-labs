import { describe, expect, it } from "vitest";
import {
  BulkRequest,
  bulkDraft,
  bulkRequest,
  changeFrom,
  changeTitle,
  CLEAR,
  planBulk,
  planLine,
  undoLine,
  type BulkChange,
} from "../bulk-labels";
import { LabelWire, PLAIN_LABEL, type Label } from "../domain";
import { CorrectionId, ExperimentId, PersonId, Sha256 } from "../ids";
import { draftOf, type LabLists } from "../label-edit";
import { rowShortcut } from "../row-keys";

const hela = { id: ExperimentId.parse("00000000-0000-4000-8000-0000000000e4"), name: "HeLa drug A" };
const gels = { id: ExperimentId.parse("00000000-0000-4000-8000-0000000000e5"), name: "Gels" };
const ade = { id: PersonId.parse("00000000-0000-4000-8000-0000000000a2"), name: "Ade Okafor" };
const lists: LabLists = { experiments: [{ ...hela, aliases: [] }, { ...gels, aliases: [] }], people: [{ ...ade, aliases: [] }] };
const sha = (c: string) => Sha256.parse(c.repeat(64));
const day = (iso: string) => `day ${iso}`;

const run: Label = {
  ...PLAIN_LABEL,
  status: "check",
  cleanName: "Drug A run 2",
  date: "2026-10-08",
  experiment: hela,
  person: ade,
  instrument: "SpectraMax",
  tags: ["mtt"],
  confidence: 0.7,
  outcome: "worked",
  summary: "Second run.",
};
const unnamed: Label = { ...PLAIN_LABEL, status: "needs_look", cleanName: null, date: null, experiment: null, person: null, instrument: null, tags: [], confidence: 0.2 };
const full: Label = { ...run, tags: Array.from({ length: 20 }, (_, i) => `t${i}`) };

describe("one change to many labels", () => {
  it("changes only the chosen field", () => {
    expect(bulkDraft(run, { field: "experiment", value: gels })).toEqual({ kind: "change", draft: { ...draftOf(run), experiment: gels } });
  });

  it("sorts every file into change, already has it, no name yet, or full", () => {
    const items = [
      { sha256: sha("a"), label: run },
      { sha256: sha("b"), label: { ...run, tags: ["mtt", "plate 3"] } },
      { sha256: sha("c"), label: unnamed },
      { sha256: sha("d"), label: null },
      { sha256: sha("e"), label: full },
      { sha256: sha("a"), label: run },
    ];
    const plan = planBulk(items, { field: "add_tag", value: "plate 3" });
    expect(plan.changes.map((c) => [c.sha256, c.draft.tags])).toEqual([[sha("a"), ["mtt", "plate 3"]]]);
    expect({ same: plan.same, unnamed: plan.unnamed, full: plan.full }).toEqual({ same: 1, unnamed: 2, full: 1 });
    expect(planLine({ ...plan, changed: plan.changes.length })).toBe(
      "Changes 1 file. 1 already has it. 2 have no name yet, so they're left out. 1 already has 20 tags.",
    );
  });

  it("removes a tag only from files that have it, and clears a field", () => {
    expect(bulkDraft(run, { field: "remove_tag", value: "gel" }).kind).toBe("same");
    const removed = bulkDraft(run, { field: "remove_tag", value: "mtt" });
    expect(removed.kind === "change" ? removed.draft.tags : null).toEqual([]);
    const cleared = bulkDraft(run, { field: "person", value: null });
    expect(cleared.kind === "change" ? cleared.draft.person : "same").toBeNull();
    expect(bulkDraft(run, { field: "outcome", value: "worked" }).kind).toBe("same");
    expect(planLine({ changed: 0, same: 3, unnamed: 0, full: 0 })).toBe("Nothing to change. 3 already have it.");
  });

  it("reads what the person picked or typed", () => {
    expect(changeFrom("experiment", gels.id, lists)).toEqual({ kind: "ok", change: { field: "experiment", value: gels } });
    expect(changeFrom("experiment", CLEAR, lists)).toEqual({ kind: "ok", change: { field: "experiment", value: null } });
    expect(changeFrom("experiment", "", lists).kind).toBe("incomplete");
    expect(changeFrom("person", "nobody", lists).kind).toBe("incomplete");
    expect(changeFrom("outcome", "failed", lists)).toEqual({ kind: "ok", change: { field: "outcome", value: "failed" } });
    expect(changeFrom("date", "Oct 14 2026", lists)).toEqual({ kind: "ok", change: { field: "date", value: "2026-10-14" } });
    expect(changeFrom("date", "next week", lists).kind).toBe("invalid");
    expect(changeFrom("add_tag", "  plate   3 ", lists)).toEqual({ kind: "ok", change: { field: "add_tag", value: "plate 3" } });
  });

  it("names the change the way the button and toast say it", () => {
    const say = (c: BulkChange) => changeTitle(c, day);
    expect(say({ field: "experiment", value: gels })).toBe("Set the experiment to Gels");
    expect(say({ field: "person", value: null })).toBe("Clear the person");
    expect(say({ field: "outcome", value: "repeat" })).toBe("Mark as a repeat");
    expect(say({ field: "date", value: "2026-10-14" })).toBe("Set the date to day 2026-10-14");
    expect(say({ field: "remove_tag", value: "mtt" })).toBe("Remove the tag “mtt”");
  });

  it("sends ids, not names, and the route accepts what the client sends", () => {
    const req = bulkRequest([sha("a")], { field: "experiment", value: gels });
    expect(req).toEqual({ shas: [sha("a")], change: { field: "experiment", value: gels.id } });
    expect(BulkRequest.safeParse(req).success).toBe(true);
    expect(BulkRequest.safeParse(bulkRequest([], { field: "outcome", value: null })).success).toBe(false);
    expect(BulkRequest.safeParse({ shas: [sha("a")], change: { field: "clean_name", value: "x" } }).success).toBe(false);
  });

  it("says how an undo went", () => {
    const label = LabelWire.parse({ ...run, cleanName: run.cleanName });
    const undone = { sha256: sha("a"), correctionId: CorrectionId.parse(4), label };
    expect(undoLine({ undone: [undone, undone], skipped: 0 })).toBe("Change undone");
    expect(undoLine({ undone: [undone], skipped: 1 })).toBe("Undone on 1 file. 1 file was changed since and keeps its newer label.");
    expect(undoLine({ undone: [], skipped: 2 })).toBe("Nothing undone. 2 files were changed since and keep their newer labels.");
  });

  it("X picks a row only where rows can be picked", () => {
    const press = (selectable: boolean) => rowShortcut({ key: "x", modified: false, repeat: false, typing: false, sheet: false, selectable });
    expect(press(true)).toBe("select");
    expect(press(false)).toBeNull();
    expect(rowShortcut({ key: "x", modified: false, repeat: false, typing: true, sheet: false, selectable: true })).toBeNull();
  });
});
