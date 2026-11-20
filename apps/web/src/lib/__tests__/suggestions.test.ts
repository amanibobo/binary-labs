import { describe, expect, it } from "vitest";
import { labelFixes } from "@/fixtures/answers";
import { draftOf, editOf, type LabelChange } from "../suggestions";

const [notes, sec, gel] = labelFixes.changes as [LabelChange, LabelChange, LabelChange, LabelChange];
const bm1 = labelFixes.lists.experiments.find((e) => e.name === "P450 BM1")?.id ?? "";
const mia = labelFixes.lists.people.find((p) => p.name === "Mia Chen")?.id ?? "";

describe("editing a label suggestion before approving", () => {
  it("starts each field from what the label becomes if approved as proposed", () => {
    expect(draftOf(gel)).toEqual({
      cleanName: "Batch 3 SDS-PAGE gel, second lane set",
      date: "2026-10-14",
      experimentId: gel.proposed.experimentId,
      personId: "",
    });
    expect(draftOf(notes)).toMatchObject({ cleanName: "Bench notes, Oct 14", personId: notes.current.personId });
  });

  it("sends nothing for a file left as proposed", () => {
    for (const change of [notes, sec, gel]) expect(editOf(change, draftOf(change))).toBeNull();
  });

  it("sends the member's values, leaving fields that match the label now as they are", () => {
    expect(editOf(notes, { ...draftOf(notes), experimentId: bm1 })).toEqual({
      sha256: notes.sha256,
      cleanName: null,
      date: null,
      experimentId: bm1,
      personId: null,
    });
    expect(editOf(gel, { ...draftOf(gel), cleanName: "  Gel, batch 3  ", personId: mia })).toEqual({
      sha256: gel.sha256,
      cleanName: "Gel, batch 3",
      date: "2026-10-14",
      experimentId: gel.proposed.experimentId,
      personId: mia,
    });
  });

  it("reads an emptied field as leave it as it is", () => {
    expect(editOf(gel, { ...draftOf(gel), cleanName: "", date: "" })).toMatchObject({ cleanName: null, date: null });
  });
});
