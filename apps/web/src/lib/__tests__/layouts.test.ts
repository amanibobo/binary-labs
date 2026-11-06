import { describe, expect, it } from "vitest";
import elisaJson from "@/fixtures/tables/ELISA_plate3.json";
import { DataTables, mainTable } from "../data-tables";
import { assignWells, clearWells, describeLayout, emptyLayout, fillSeries, layoutChoices, layoutFromFile, pasteLayout, readLabel, SampleLayout, wellsBetween, type SavedLayout } from "../layouts";
import { LayoutId, ProtocolId } from "../ids";

describe("reading a well's label", () => {
  it.each([
    ["BLK", "blank", "", null],
    ["Blank 2", "blank", "", null],
    ["CTL", "control", "", null],
    ["Vehicle", "control", "Vehicle", null],
    ["STD3", "standard", "STD3", null],
    ["Std 250 µg/mL", "standard", "", 250],
    ["Drug A 10 uM", "sample", "Drug A", 10],
    ["Lysate rep 1", "sample", "Lysate", null],
    ["Elution 1", "sample", "Elution 1", null],
  ])("%s", (text, role, name, conc) => {
    expect(readLabel(text)).toMatchObject({ role, name, conc });
  });
  it("reads µM from a typed uM", () => {
    expect(readLabel("Drug A 10 uM")?.unit).toBe("µM");
  });
});

describe("painting a layout", () => {
  const blank = emptyLayout(96, "µM");
  it("drags across a rectangle of wells", () => {
    expect(wellsBetween({ row: 1, column: 2 }, { row: 0, column: 0 })).toEqual(["A1", "A2", "A3", "B1", "B2", "B3"]);
  });
  it("keeps repeats as one group and moves a repainted well", () => {
    let l = assignWells(blank, ["A1", "B1"], { role: "blank", name: "", conc: null, dilution: null });
    l = assignWells(l, ["C1"], { role: "blank", name: "", conc: null, dilution: null });
    expect(l.groups).toEqual([{ role: "blank", name: "", conc: null, dilution: null, wells: ["A1", "B1", "C1"] }]);
    l = assignWells(l, ["B1"], { role: "control", name: "", conc: null, dilution: null });
    expect(l.groups.map((g) => [g.role, g.wells])).toEqual([
      ["blank", ["A1", "C1"]],
      ["control", ["B1"]],
    ]);
    expect(clearWells(l, ["A1", "C1", "B1"]).groups).toEqual([]);
  });
  it("fills a dilution series across, each column a dose and its rows repeats", () => {
    const l = fillSeries(blank, wellsBetween({ row: 1, column: 2 }, { row: 3, column: 6 }), { role: "sample", name: "Drug A", start: 100, factor: 5, direction: "across" });
    expect(l.groups.map((g) => [g.conc, g.wells.join(" ")])).toEqual([
      [100, "B3 C3 D3"],
      [20, "B4 C4 D4"],
      [4, "B5 C5 D5"],
      [0.8, "B6 C6 D6"],
      [0.16, "B7 C7 D7"],
    ]);
    expect(describeLayout(l)).toBe("Drug A at 5 concentrations (3 wells each)");
  });
  it("fills down a column too", () => {
    const l = fillSeries(blank, wellsBetween({ row: 0, column: 0 }, { row: 7, column: 1 }), { role: "standard", name: "", start: 2000, factor: 2, direction: "down" });
    expect(l.groups.map((g) => g.conc)).toEqual([2000, 1000, 500, 250, 125, 62.5, 31.25, 15.625]);
    expect(l.groups[0]?.wells).toEqual(["A1", "A2"]);
  });
  it("pastes a grid of labels from a spreadsheet, with or without the plate's numbers and letters", () => {
    const grid = "\t1\t2\t3\nA\tBLK\tCTL\tDrug A 10 µM\nB\tBLK\tCTL\tDrug A 10 µM\n";
    const pasted = pasteLayout(blank, grid);
    expect(pasted.wells).toBe(6);
    expect(pasted.layout.groups.map((g) => [g.role, g.name, g.conc, g.wells.join(" ")])).toEqual([
      ["blank", "", null, "A1 B1"],
      ["control", "", null, "A2 B2"],
      ["sample", "Drug A", 10, "A3 B3"],
    ]);
    const bare = pasteLayout(blank, "Blank,Std 1\nBlank,Std 1");
    expect(bare.layout.groups.map((g) => g.wells.join(" "))).toEqual(["A1 B1", "A2 B2"]);
  });
  it("pastes a grid of numbers as concentrations of the wells already marked", () => {
    let l = assignWells(blank, ["A1", "A2"], { role: "standard", name: "", conc: null, dilution: null });
    l = pasteLayout(l, "500\t250").layout;
    expect(l.groups.map((g) => [g.role, g.conc, g.wells])).toEqual([
      ["standard", 500, ["A1"]],
      ["standard", 250, ["A2"]],
    ]);
  });
  it("refuses a well twice or off the plate", () => {
    expect(SampleLayout.safeParse({ size: 96, unit: "", groups: [{ role: "blank", name: "", conc: null, dilution: null, wells: ["A1", "A1"] }] }).success).toBe(false);
    expect(SampleLayout.safeParse({ size: 96, unit: "", groups: [{ role: "blank", name: "", conc: null, dilution: null, wells: ["I1"] }] }).success).toBe(false);
  });
});

describe("layouts from the export", () => {
  it("reads a plate listed by well with its sample names", () => {
    const doc = DataTables.parse(elisaJson);
    const table = mainTable(doc);
    if (table === null) throw new Error("no table");
    const found = layoutFromFile(doc, table);
    expect(found?.from).toBe("the Sample column");
    expect(found?.layout.groups.filter((g) => g.role === "standard")).toHaveLength(8);
    expect(found?.layout.groups.find((g) => g.role === "blank")?.wells).toEqual(["H11", "H12"]);
  });
});

describe("saved layouts", () => {
  const protocol = ProtocolId.parse("00000000-0000-4000-8000-0000000000a1");
  const saved = (id: string, protocolId: ProtocolId | null, updatedAt: string, size: 96 | 384 = 96): SavedLayout => ({
    id: LayoutId.parse(`00000000-0000-4000-8000-00000000000${id}`),
    name: id,
    protocolId,
    sha256: null,
    layout: emptyLayout(size),
    updatedAt,
  });
  it("offers this protocol's first, then the newest, and only this plate size", () => {
    const list = [saved("1", null, "2026-11-05"), saved("2", protocol, "2026-11-01"), saved("3", null, "2026-11-04", 384)];
    expect(layoutChoices(list, 96, protocol).map((l) => l.name)).toEqual(["2", "1"]);
  });
});
