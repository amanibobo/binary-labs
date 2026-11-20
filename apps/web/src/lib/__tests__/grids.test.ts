import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import linesJson from "@/fixtures/tables/viability_lines_by_day.json";
import groupsJson from "@/fixtures/tables/treatments_4groups.json";
import elisaJson from "@/fixtures/tables/ELISA_plate3.json";
import { chartCsv, exportFigure, figureMarkup } from "@/components/charts/chart-export";
import { parseSvg } from "../pdf";
import { describeChart, kindsFor, startChart, suggestionsFor, switchKind } from "../chart-guide";
import { ChartSpec, checkSpec, startingGrid, type GridSpec } from "../charts";
import { DataTables, mainTable, type DataTable } from "../data-tables";
import { categories, gridCells, isCategoryColumn } from "../grids";
import { ColumnId } from "../ids";
import { plotGrid } from "../plate-geometry";

const first = (json: unknown): DataTable => {
  const t = mainTable(DataTables.parse(json));
  if (t === null) throw new Error("no table");
  return t;
};
const lines = first(linesJson);
const groups = first(groupsJson);
const elisa = first(elisaJson);
const col = (table: DataTable, name: string) => {
  const c = table.columns.find((x) => x.name === name);
  if (c === undefined) throw new Error(name);
  return c;
};
const grid = (spec: ChartSpec | null): GridSpec => {
  if (spec === null || spec.type !== "grid") throw new Error("not a grid");
  return spec;
};

describe("a heatmap of two columns", () => {
  it("sorts words as the sheet lists them and numbers from low to high", () => {
    expect(categories(col(lines, "Cell line")).names).toEqual(["HeLa", "HEK293", "MCF7", "A549"]);
    expect(categories(col(lines, "Day")).names).toEqual(["1", "2", "3", "5"]);
  });

  it("takes columns that sort the rows, not readings or columns of unique names", () => {
    expect(isCategoryColumn(col(lines, "Cell line"))).toBe(true);
    expect(isCategoryColumn(col(lines, "Viability"))).toBe(false);
    expect(isCategoryColumn(col(elisa, "Well"))).toBe(false);
  });

  it("starts on cell line down the side, day across and the viability's mean in each square", () => {
    const spec = grid(startingGrid(lines));
    expect([col(lines, "Cell line").id, col(lines, "Day").id, col(lines, "Viability").id]).toEqual([spec.rows, spec.columns, spec.measure]);
    const data = gridCells(spec, lines);
    expect(data?.cells).toHaveLength(16);
    const viability = col(lines, "Viability");
    const hela1 = [0, 1, 2].map((r) => (viability.kind === "number" ? (viability.values[r] ?? NaN) : NaN));
    const cell = data?.cells[0];
    expect(cell?.rows).toEqual([0, 1, 2]);
    expect(cell?.value).toBeCloseTo((hela1[0] + hela1[1] + hela1[2]) / 3, 12);
  });

  it("says what each square is under the title", () => {
    const spec = grid(startingGrid(lines));
    expect(describeChart(spec, lines)).toMatch(/^Viability \(%\) for each Cell line \(down the side\) and Day \(across the top\), 4 by 4, from [\d.]+ to [\d.]+\. Each square is the mean of the rows with that pair, as the scale under it shows\.$/);
  });

  it("is offered for a sheet that has two such columns, and not for a plate or one group column", () => {
    const data = { table: lines, tables: [lines], layout: null };
    expect(kindsFor(data)).toContain("grid");
    expect(suggestionsFor(data).map((s) => s.kind)).toContain("grid");
    expect(kindsFor({ table: groups, tables: [groups], layout: null })).not.toContain("grid");
    expect(kindsFor({ table: elisa, tables: [elisa], layout: null })).not.toContain("grid");
  });

  it("switches to and from a line chart of the same sheet", () => {
    const data = { table: lines, tables: [lines], layout: null };
    const spec = grid(startChart(data, "grid"));
    const line = switchKind(spec, "line", data, null);
    expect(line?.type).not.toBe("grid");
    expect(switchKind(line ?? spec, "grid", data, spec)).toBe(spec);
  });

  it("refuses the same column on both sides, a reading as a side and a text measure", () => {
    const spec = grid(startingGrid(lines));
    expect(checkSpec({ ...spec, columns: spec.rows }, lines)).toBe("Pick two different columns for the side and the top.");
    expect(checkSpec({ ...spec, rows: spec.measure }, lines)).toMatch(/too many for a heatmap/);
    expect(checkSpec({ ...spec, measure: spec.rows }, lines)).toMatch(/holds text, so it can't color the squares/);
    expect(ChartSpec.safeParse({ ...spec, rows: ColumnId.parse("A") }).success).toBe(true);
  });

  it("draws squares with an empty one for a pair no row has, and says so", () => {
    const spec = grid(startingGrid(lines));
    const missing: DataTable = { ...lines, columns: lines.columns.map((c) => (c.id === spec.measure && c.kind === "number" ? { ...c, values: c.values.map((v, r) => (r < 3 ? null : v)) } : c)) };
    const plot = plotGrid(spec, missing, { width: 600, height: 2000 });
    expect(plot.shape).toBe("square");
    expect(plot.wells).toHaveLength(16);
    expect(plot.wells[0]).toMatchObject({ name: "HeLa, 1", value: null, missing: true });
    expect(plot.wells[1]).toMatchObject({ name: "HeLa, 2", label: "mean of 3 rows", missing: false });
    expect(plot.notes).toContain("1 pair has no row, so its square is empty.");
    expect(plot.rowLabels.map((l) => l.text)).toEqual(["HeLa", "HEK293", "MCF7", "A549"]);
  });

  it("slants column names that are wider than their squares", () => {
    const spec = grid(startingGrid(lines));
    const turned = plotGrid({ ...spec, rows: spec.columns, columns: spec.rows }, lines, { width: 140, height: 2000 });
    expect(turned.columnLabels.every((l) => l.slant)).toBe(true);
    expect(plotGrid(spec, lines, { width: 600, height: 2000 }).columnLabels.some((l) => l.slant)).toBe(false);
  });

  it("exports as squares with its title and the numbers behind it, unrounded", () => {
    const spec = grid(startingGrid(lines));
    const file = figureMarkup(exportFigure(spec, lines, "Viability by day", "column"), renderToStaticMarkup);
    const svg = parseSvg(file.markup);
    expect(file.mm?.width).toBe(85);
    expect(file.markup).toContain("Viability by day");
    expect(JSON.stringify(svg).match(/"rect"/g)?.length).toBeGreaterThanOrEqual(16);
    const csv = chartCsv(spec, lines, "Viability by day", ["Made from viability_lines_by_day.csv"]).split("\r\n");
    expect(csv[4]).toBe("Cell line,Day,Mean Viability (%),n");
    expect(csv).toHaveLength(5 + 16 + 1);
    const mean = gridCells(spec, lines)?.cells[0]?.value;
    expect(csv[5]).toBe(`HeLa,1,${mean},3`);
  });
});
