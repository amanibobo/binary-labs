import { describe, expect, it } from "vitest";
import type { Label } from "../domain";
import { ExperimentId, PersonId } from "../ids";
import { isRowKey, rowStep } from "../row-keys";
import { rowSummary, tagCount, textOverflows } from "../row-summary";

const screen = { id: ExperimentId.parse("00000000-0000-4000-8000-0000000000e3"), name: "Solubility screen" };
const ade = { id: PersonId.parse("00000000-0000-4000-8000-0000000000a2"), name: "Ade Okafor" };

const plate: Label = {
  status: "check",
  cleanName: "Plate 7 absorbance at 420 nm",
  date: "2026-11-03",
  experiment: screen,
  person: ade,
  instrument: "Plate reader",
  tags: ["absorbance", "kinetic", "420 nm", "plate 7", "96-well"],
  confidence: 0.6,
};

describe("rowSummary", () => {
  it("shows the experiment and person, never the date, and counts the tags", () => {
    expect(rowSummary(plate)).toEqual({ kind: "labeled", facts: ["Solubility screen", "Ade Okafor"], tags: plate.tags, check: true });
  });

  it("fills a missing experiment or person with the instrument, two facts at most", () => {
    expect(rowSummary({ ...plate, person: null })).toMatchObject({ facts: ["Solubility screen", "Plate reader"] });
    expect(rowSummary({ ...plate, experiment: null, person: null })).toMatchObject({ facts: ["Plate reader"] });
    expect(rowSummary({ ...plate, experiment: null, person: null, instrument: "  " })).toMatchObject({ facts: [] });
  });

  it("marks only a check label for a look", () => {
    expect(rowSummary({ ...plate, status: "suggested" })).toMatchObject({ check: false });
    expect(rowSummary({ ...plate, status: "accepted" })).toMatchObject({ check: false });
  });

  it("says nothing for a file not labeled yet, and sends a queued one to Needs a look", () => {
    expect(rowSummary(null)).toEqual({ kind: "unlabeled" });
    expect(rowSummary({ ...plate, status: "needs_look", cleanName: null })).toEqual({ kind: "needs_look" });
  });
});

describe("tagCount", () => {
  it("names the count, or nothing for no tags", () => {
    expect(tagCount(0)).toBeNull();
    expect(tagCount(1)).toBe("1 tag");
    expect(tagCount(5)).toBe("5 tags");
  });
});

describe("textOverflows", () => {
  it("offers Show more past eight lines or 480 characters", () => {
    expect(textOverflows("one\ntwo")).toBe(false);
    expect(textOverflows(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"))).toBe(true);
    expect(textOverflows("x".repeat(481))).toBe(true);
  });
});

describe("rowStep", () => {
  it("steps one row and stops at the ends", () => {
    expect(rowStep({ key: "ArrowDown", index: 0, count: 3 })).toBe(1);
    expect(rowStep({ key: "ArrowDown", index: 2, count: 3 })).toBeNull();
    expect(rowStep({ key: "ArrowUp", index: 1, count: 3 })).toBe(0);
    expect(rowStep({ key: "ArrowUp", index: 0, count: 3 })).toBeNull();
  });

  it("goes to the first and last row", () => {
    expect(rowStep({ key: "Home", index: 2, count: 3 })).toBe(0);
    expect(rowStep({ key: "End", index: 0, count: 3 })).toBe(2);
    expect(rowStep({ key: "Home", index: 0, count: 3 })).toBeNull();
  });

  it("enters the list from the search box at the first row", () => {
    expect(rowStep({ key: "ArrowDown", index: -1, count: 3 })).toBe(0);
    expect(rowStep({ key: "ArrowDown", index: -1, count: 0 })).toBeNull();
  });

  it("leaves every other key to the browser", () => {
    expect(isRowKey("ArrowDown")).toBe(true);
    expect(isRowKey("Enter")).toBe(false);
    expect(isRowKey("ArrowLeft")).toBe(false);
  });
});
