import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import bradfordJson from "@/fixtures/tables/Bradford_2026-10-30.json";
import elisaJson from "@/fixtures/tables/ELISA_plate3.json";
import plateJson from "@/fixtures/tables/plate7_A420.json";
import secJson from "@/fixtures/tables/SEC_trace_141026.json";
import { ChartSpec, startingHeatmap, type HeatmapSpec } from "../charts";
import { DataTables, type DataTable } from "../data-tables";
import { ColumnId } from "../ids";
import { exportFill, mixOklab, plotPlate, readLabel, SEQUENTIAL } from "../plate-geometry";
import { parseWell, plateCells, plateLayout } from "../plates";

const grid = DataTables.parse(bradfordJson).tables[2];
const list = DataTables.parse(elisaJson).tables[0];
const kinetic = DataTables.parse(plateJson).tables[0];
const sec = DataTables.parse(secJson).tables[0];
const col = (id: string) => ColumnId.parse(id);
const heat = (table: DataTable): HeatmapSpec => {
  const s = startingHeatmap(table);
  if (s === null) throw new Error(`${table.name} isn't a plate`);
  return s;
};

// A 384-well read listed one well per row, A1 to P24.
const big: DataTable = {
  name: "Plate 384",
  sheet: "",
  notes: [],
  rows: 384,
  truncated: false,
  rowsInFile: null,
  columns: [
    { id: col("A"), name: "Well", unit: null, kind: "text", invalid: 0, note: null, values: Array.from({ length: 384 }, (_, i) => `${"ABCDEFGHIJKLMNOP"[Math.floor(i / 24)]}${String((i % 24) + 1).padStart(2, "0")}`) },
    { id: col("B"), name: "RFU", unit: null, kind: "number", invalid: 0, note: null, values: Array.from({ length: 384 }, (_, i) => i) },
  ],
};

describe("finding a plate in a table", () => {
  it("reads well names, padded or not", () => {
    expect(parseWell("A1")).toEqual({ row: 0, column: 0 });
    expect(parseWell("h12")).toEqual({ row: 7, column: 11 });
    expect(parseWell("P24")).toEqual({ row: 15, column: 23 });
    expect(parseWell("B03")).toEqual({ row: 1, column: 2 });
    expect(parseWell("Q1")).toBeNull();
    expect(parseWell("A25")).toBeNull();
    expect(parseWell("Std 1")).toBeNull();
  });

  it("finds the grid the parser kept under a blank corner", () => {
    const layout = plateLayout(grid);
    expect(layout).toMatchObject({ kind: "grid", size: 96, rows: { id: "A" } });
    expect(layout?.kind === "grid" ? layout.columns.map((c) => c.index) : []).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const cells = layout === null ? [] : plateCells(grid, layout, { kind: "grid", rows: col("A") });
    expect(cells).toHaveLength(96);
    expect(cells[13]).toMatchObject({ name: "B2", row: 1, column: 1 });
  });

  it("finds a list of wells, with the sample beside each", () => {
    const layout = plateLayout(list);
    expect(layout).toMatchObject({ kind: "wells", size: 96, well: { id: "A" }, label: { id: "B" } });
    const cells = layout === null ? [] : plateCells(list, layout, { kind: "wells", well: col("A"), value: col("C") });
    expect(cells).toHaveLength(96);
    expect(cells.find((c) => c.name === "H12")).toMatchObject({ label: "Blank" });
  });

  it("finds a 384-well plate from its rows past H and columns past 12", () => {
    expect(plateLayout(big)).toMatchObject({ kind: "wells", size: 384 });
  });

  it("finds a kinetic read's column per well and its time", () => {
    const layout = plateLayout(kinetic);
    expect(layout).toMatchObject({ kind: "read", size: 96, time: { id: "A" } });
    expect(layout?.kind === "read" ? layout.wells.length : 0).toBe(96);
  });

  it("doesn't take an AKTA run's fraction list for a plate", () => {
    expect(plateLayout(sec)).toBeNull();
  });
});

describe("a plate heatmap", () => {
  it("lays out 8 by 12 wells in order, colored from low to high", () => {
    const plot = plotPlate(heat(list), list, { width: 800, height: 600 });
    expect(plot.wells).toHaveLength(96);
    expect([plot.rows, plot.columns]).toEqual([8, 12]);
    const a1 = plot.wells[0];
    const a2 = plot.wells[1];
    const b1 = plot.wells[12];
    expect(a2.cx - a1.cx).toBeCloseTo(plot.pitch);
    expect(b1.cy - a1.cy).toBeCloseTo(plot.pitch);
    const ts = plot.wells.map((w) => w.t ?? -1);
    expect(Math.min(...ts)).toBe(0);
    expect(Math.max(...ts)).toBe(1);
    expect(plot.scale?.ticks.length).toBeGreaterThan(1);
    expect(plot.rowLabels.map((l) => l.text).join("")).toBe("ABCDEFGH");
  });

  it("lays out 16 by 24 for a 384-well plate, labeling every other row on a narrow screen", () => {
    const plot = plotPlate(heat(big), big, { width: 360, height: 600 });
    expect([plot.rows, plot.columns, plot.wells.length]).toEqual([16, 24, 384]);
    expect(plot.pitch).toBeLessThan(16);
    expect(plot.rowLabels).toHaveLength(8);
  });

  it("shows one read of a kinetic plate, and says which", () => {
    const spec = ChartSpec.parse({ ...heat(kinetic), plate: { size: 96, source: { kind: "read", row: 30 } } });
    if (spec.type !== "heatmap") throw new Error("not a plate");
    const plot = plotPlate(spec, kinetic, { width: 800, height: 600 });
    expect(readLabel(spec, kinetic)).toBe("Read 31 of 31, at 30 min");
    // The two saturated wells read OVRFLW at 30 min: no number, drawn as empty rings.
    expect(plot.wells.filter((w) => w.value === null).map((w) => w.name)).toEqual(["H11", "H12"]);
    expect(plot.notes).toContain("2 wells have no number.");
  });

  it("keeps a fixed scale when the spec sets one", () => {
    const spec: HeatmapSpec = { ...heat(list), value: { title: "OD450", unit: "", min: 0, max: 4 } };
    const plot = plotPlate(spec, list, { width: 800, height: 600 });
    expect(plot.scale).toMatchObject({ lo: 0, hi: 4 });
    expect(Math.max(...plot.wells.map((w) => w.t ?? 0))).toBeLessThan(1);
  });
});

describe("the plate ramp", () => {
  it("exports the light steps at its ends and mixes between them in OKLab", () => {
    expect(exportFill(0)).toBe(SEQUENTIAL.light[0]);
    expect(exportFill(1)).toBe(SEQUENTIAL.light[4]);
    expect(exportFill(0.5)).toBe(SEQUENTIAL.light[2]);
    expect(mixOklab("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixOklab("#2a78d6", "#2a78d6", 0.5)).toBe("#2a78d6");
  });

  it("is the same steps in globals.css, in each theme", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    const [light, dark] = css.split(':root[data-theme="dark"]');
    const steps = (block: string) => [0, 1, 2, 3, 4].map((i) => new RegExp(`--chart-seq-${i}:\\s*(#[0-9a-f]{6});`).exec(block)?.[1]);
    expect(steps(light)).toEqual([...SEQUENTIAL.light]);
    expect(steps(dark)).toEqual([...SEQUENTIAL.dark]);
  });
});
