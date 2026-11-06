import { describe, expect, it } from "vitest";
import bradfordJson from "@/fixtures/tables/Bradford_2026-10-30.json";
import elisaJson from "@/fixtures/tables/ELISA_plate3.json";
import plateJson from "@/fixtures/tables/plate7_A420.json";
import { addSeries, labelText, removeSeries, rename, restyle, setBottom, setErrorBars, spreadsFor } from "../chart-edits";
import { startFor, startingChart, switched, switchProblem } from "../chart-guide";
import { isXY, specProblem, type ChartSpec, type XYSpec } from "../charts";
import { DataTables, findColumn, type DataColumn, type DataTable } from "../data-tables";
import { ColumnId } from "../ids";

const table = (json: unknown, name = "Table 1"): DataTable => {
  const t = DataTables.parse(json).tables.find((x) => x.name === name);
  if (t === undefined) throw new Error(name);
  return t;
};
const standards = table(bradfordJson, "Standards");
const kinetic = table(plateJson);
const elisa = table(elisaJson);
const col = (t: DataTable, id: string): DataColumn => {
  const c = findColumn(t, ColumnId.parse(id));
  if (c === undefined) throw new Error(id);
  return c;
};
const xy = (spec: ChartSpec | null): XYSpec => {
  if (spec === null || !isXY(spec)) throw new Error("not an x/y chart");
  return spec;
};
const curve = xy(startFor(standards, "scatter"));

describe("editing on the chart", () => {
  it("renames an axis with its unit, and a series, from what was typed", () => {
    const y = xy(rename(curve, standards, { kind: "y" }, "Absorbance at 595 nm (AU)"));
    expect(y.y).toMatchObject({ title: "Absorbance at 595 nm", unit: "AU" });
    expect(labelText(y, { kind: "y" })).toBe("Absorbance at 595 nm (AU)");
    const named = xy(rename(curve, standards, { kind: "series", column: ColumnId.parse("E") }, "Mean of 3"));
    expect(named.series[0].name).toBe("Mean of 3");
    expect(rename(curve, standards, { kind: "series", column: ColumnId.parse("E") }, "  ")).toBe(curve);
  });

  it("renames what a plate's colors show", () => {
    const plate = startingChart(elisa);
    if (plate === null) throw new Error("no plate");
    expect(rename(plate, elisa, { kind: "value" }, "Signal (OD)")).toMatchObject({ value: { title: "Signal", unit: "OD" } });
  });

  it("gives a clicked line another's color by swapping, so no two look alike", () => {
    const three = xy(startingChart(kinetic));
    const swapped = restyle(three, ColumnId.parse("C"), { color: "orange", stroke: "solid" });
    expect(swapped.series.map((s) => s.color)).toEqual(["orange", "blue", "aqua"]);
    expect(specProblem(swapped)).toBeNull();
    const dashed = restyle(three, three.series[1].column, { color: "orange", stroke: "dashed" });
    expect(dashed.series[1]).toMatchObject({ color: "orange", stroke: "dashed" });
  });
});

describe("the panel's edits", () => {
  it("turns the repeats' spread on and off", () => {
    expect(spreadsFor(curve, standards)).toEqual([{ column: "E", error: "F" }]);
    const off = setErrorBars(curve, standards, false);
    expect(off.series[0].error).toBeNull();
    expect(setErrorBars(off, standards, true).series[0].error).toBe("F");
  });

  it("adds and removes measured columns, keeping the side axis named for one and blank for several", () => {
    const one = xy(startFor(standards, "scatter"));
    const two = addSeries(one, standards, col(standards, "B"));
    expect(two.series.map((s) => [s.column, s.color, s.error])).toEqual([
      ["E", "blue", "F"],
      ["B", "orange", null],
    ]);
    expect(two.y).toMatchObject({ title: "", unit: "AU" });
    expect(addSeries(two, standards, col(standards, "A"))).toBe(two);
    const back = removeSeries(two, standards, ColumnId.parse("B"));
    expect(back.y).toMatchObject({ title: "Mean", unit: "AU" });
    expect(removeSeries(back, standards, ColumnId.parse("E"))).toBe(back);
  });

  it("moves a measured column along the bottom, dropping it from the measured", () => {
    const two = addSeries(curve, standards, col(standards, "B"));
    const moved = setBottom(two, standards, col(standards, "B"));
    expect(moved.x).toMatchObject({ column: "B", title: "A595 Rep 1", unit: "AU" });
    expect(moved.series.map((s) => s.column)).toEqual(["E"]);
  });
});

describe("switching the kind of chart", () => {
  it("goes from a plate to lines of its wells, and says why when a sheet can't", () => {
    const plate = startFor(kinetic, "heatmap");
    if (plate === null) throw new Error("no plate");
    expect(xy(switched(plate, "line", kinetic, null)).series).toHaveLength(3);
    const elisaPlate = startingChart(elisa);
    if (elisaPlate === null) throw new Error("no plate");
    expect(switchProblem(elisaPlate, "line", elisa, null)).toBe("There's one column of numbers, and nothing to set it against.");
    expect(switchProblem(elisaPlate, "bar", elisa, null)).toBe("96 rows in the sheet are too many for bars.");
  });
});
