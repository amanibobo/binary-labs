import { describe, expect, it } from "vitest";
import bioreactorJson from "@/fixtures/tables/Bioreactor_run12.json";
import bradfordJson from "@/fixtures/tables/Bradford_2026-10-30.json";
import elisaJson from "@/fixtures/tables/ELISA_plate3.json";
import plateJson from "@/fixtures/tables/plate7_A420.json";
import secJson from "@/fixtures/tables/SEC_trace_141026.json";
import { ChartSpec, isXY, type XYSpec } from "../charts";
import { plotChart } from "../chart-geometry";
import {
  chartWarnings,
  choiceProblem,
  choicesFor,
  columnSample,
  describeChart,
  recommend,
  splitAxisText,
  startFor,
  startingChart,
  switchProblem,
} from "../chart-guide";
import { DataTables, mainTable, spreadFor, type DataTable } from "../data-tables";
import { ColumnId } from "../ids";

const doc = (json: unknown) => DataTables.parse(json);
const table = (json: unknown, name = "Table 1"): DataTable => {
  const t = doc(json).tables.find((x) => x.name === name);
  if (t === undefined) throw new Error(name);
  return t;
};
const standards = table(bradfordJson, "Standards");
const samples = table(bradfordJson, "Samples");
const bradfordPlate = table(bradfordJson, "Plate");
const kinetic = table(plateJson);
const sec = table(secJson);
const bioreactor = table(bioreactorJson);
const elisa = table(elisaJson);
const col = (id: string) => ColumnId.parse(id);
const xy = (spec: ChartSpec | null): XYSpec => {
  if (spec === null || !isXY(spec)) throw new Error("not an x/y chart");
  return spec;
};

describe("the sheet a new chart opens on", () => {
  it("is a workbook's first sheet, as Excel opens it, not its biggest", () => {
    expect(mainTable(doc(bradfordJson))?.name).toBe("Standards");
    expect(mainTable(doc(plateJson))?.columns).toHaveLength(98);
  });
});

describe("the suggested chart", () => {
  it("is a scatter for a standard curve, saying why", () => {
    expect(recommend(standards)).toEqual({
      type: "scatter",
      reason: "Each of the 8 rows pairs a BSA value with a reading, as in a standard curve.",
    });
  });

  it("is a line for time, dates and long traces", () => {
    expect(recommend(kinetic)).toEqual({ type: "line", reason: "Each well was read 31 times, so lines show how the wells change. It starts with the wells that ended lowest, in the middle and highest." });
    expect(recommend(bioreactor)).toEqual({ type: "line", reason: "Timestamp holds dates, so a line shows how things change over time." });
    expect(recommend(sec)).toEqual({ type: "line", reason: "There are 961 readings along UV 1_280, so a line follows them." });
  });

  it("is bars for named samples and a plate map for a plate", () => {
    expect(recommend(samples)).toEqual({ type: "bar", reason: "The rows are Lysate, Flow-through, Wash and 4 more, so bars put them side by side." });
    expect(recommend(elisa)).toEqual({ type: "heatmap", reason: "This sheet is laid out like a 96-well plate." });
    expect(recommend(bradfordPlate)?.type).toBe("heatmap");
  });

  it("is nothing for a sheet of text", () => {
    expect(recommend({ ...samples, columns: [samples.columns[0]] })).toBeNull();
  });

  it("offers a plate map only for a plate", () => {
    expect(choicesFor(standards).map((c) => c.type)).toEqual(["line", "bar", "scatter"]);
    expect(choicesFor(elisa).map((c) => c.type)).toEqual(["line", "bar", "scatter", "heatmap"]);
  });
});

describe("a chart's first columns", () => {
  it("start a standard curve from the repeats themselves, and the sheet's Mean ± SD columns as a plain scatter", () => {
    expect(startingChart(standards)).toMatchObject({ type: "curve", source: { kind: "rows", key: "A", series: [{ name: "A595", values: ["B", "C", "D"] }] }, fit: "line" });
    expect(spreadFor(standards, standards.columns[4])?.id).toBe("F");
    expect(spreadFor(standards, standards.columns[1])).toBeNull();
    expect(startFor(standards, "scatter")).toEqual({
      version: 1,
      type: "scatter",
      x: { column: "A", title: "BSA", unit: "µg/mL", scale: "linear", min: null, max: null },
      y: { title: "Mean", unit: "AU", scale: "linear", min: null, max: null },
      series: [{ column: "E", name: "Mean", color: "blue", stroke: "solid", error: "F", x: null }],
      legend: "top",
    });
  });

  it("draw a kinetic read's lowest, middle and highest wells over time, skipping the flat temperature", () => {
    const spec = xy(startingChart(kinetic));
    expect(spec.x).toMatchObject({ column: "A", title: "Time", unit: "min" });
    expect(spec.series.map((s) => [s.name, s.color])).toEqual([
      ["A1", "blue"],
      ["D9", "orange"],
      ["H2", "aqua"],
    ]);
    expect(spec.y).toMatchObject({ title: "", unit: "" });
  });

  it("put named samples along the bottom of bars, passing over the dilution", () => {
    expect(xy(startingChart(samples))).toMatchObject({ type: "bar", x: { column: "A" }, series: [{ column: "C", name: "A595" }] });
  });

  it("start every kind the sheet allows, and say why not for the rest", () => {
    expect(xy(startFor(standards, "line"))).toMatchObject({ type: "line", series: [{ column: "E", error: "F" }] });
    expect(xy(startFor(standards, "bar"))).toMatchObject({ type: "bar", x: { column: "A" } });
    expect(choiceProblem(standards, "bar")).toBeNull();
    expect(choiceProblem(sec, "bar")).toBe("961 rows in the sheet are too many for bars. A line reads better.");
    expect(choiceProblem(standards, "heatmap")).toBe("This sheet isn't laid out as a plate.");
    expect(startFor(elisa, "heatmap")).toMatchObject({ type: "heatmap", plate: { size: 96 } });
    expect(xy(startFor(samples, "scatter"))).toMatchObject({ x: { column: "B" } });
    const parsed = ChartSpec.safeParse(startingChart(kinetic));
    expect(parsed.success).toBe(true);
  });

  it("can't switch five lines to a scatter", () => {
    const five = xy(startFor(kinetic, "line"));
    const more = { ...five, series: [...five.series, { ...five.series[0], column: col("F"), name: "A4", color: "violet" as const }, { ...five.series[0], column: col("G"), name: "A5", color: "magenta" as const }] };
    expect(switchProblem(more, "scatter", kinetic, null)).toBe("A scatter chart shows up to 3 columns, and this one has 5.");
    expect(switchProblem(five, "bar", kinetic, null)).toBeNull();
  });
});

describe("the sentence under a chart", () => {
  it("names the measurement, the count, the range with units, the repeats and the error bars", () => {
    expect(describeChart(xy(startFor(standards, "scatter")), standards)).toBe(
      "Mean (AU) for 8 BSA values from 0 to 2,000 µg/mL, each the mean of 3 repeats in the sheet, with bars showing how much the repeats vary (± SD).",
    );
  });

  it("follows renamed axes and a log scale", () => {
    const spec = xy(startFor(standards, "scatter"));
    const renamed = { ...spec, x: { ...spec.x, title: "BSA standard" }, y: { ...spec.y, title: "Absorbance at 595 nm", scale: "log" as const } };
    expect(describeChart(renamed, standards)).toBe(
      "Absorbance at 595 nm (AU) for 8 BSA standard values from 0 to 2,000 µg/mL, each the mean of 3 repeats in the sheet, with bars showing how much the repeats vary (± SD). The side axis is a log scale, so each step up is ten times the one before.",
    );
  });

  it("drops the error bars and repeats when they're off", () => {
    const spec = xy(startFor(standards, "scatter"));
    const plain = { ...spec, series: [{ ...spec.series[0], column: col("B"), name: "A595 Rep 1", error: null }], y: { ...spec.y, title: "A595 Rep 1" } };
    expect(describeChart(plain, standards)).toBe("A595 Rep 1 (AU) for 8 BSA values from 0 to 2,000 µg/mL.");
  });

  it("lists the lines of a kinetic read and their points", () => {
    expect(describeChart(xy(startingChart(kinetic)), kinetic)).toBe("A1, D9 and H2 as Time goes from 0 to 30 min, 31 points each.");
  });

  it("names dates, bars and cut ranges", () => {
    expect(describeChart(xy(startingChart(bioreactor)), bioreactor)).toMatch(/^pH as Timestamp goes from .+ 2026, 09:00 to .+, 289 points\.$/);
    expect(describeChart(xy(startingChart(samples)), samples)).toBe("A595 (AU) for each Sample: Lysate, Flow-through, Wash and 4 more.");
    const spec = xy(startingChart(sec));
    const cut = { ...spec, x: { ...spec.x, min: 5, max: 20 } };
    expect(describeChart(cut, sec)).toBe("UV 1_280 (mAU) as UV 1_280 goes from 0 to 24 ml, 961 points. Only UV 1_280 from 5 to 20 ml is shown.");
  });

  it("describes a plate and which read it is", () => {
    const spec = startingChart(elisa);
    if (spec === null) throw new Error("no plate");
    expect(describeChart(spec, elisa)).toBe("OD450 in each well of a 96-well plate, from 0.041 to 2.973, as the scale under the plate shows.");
    const read = startFor(kinetic, "heatmap");
    if (read === null) throw new Error("no read");
    expect(describeChart(read, kinetic)).toMatch(/ in each well of a 96-well plate, from .+\. This is read 31 of 31, at 30 min\.$/);
  });
});

describe("warnings", () => {
  it("say when units differ on one axis and a line doubles back", () => {
    const spec = xy(startFor(sec, "line"));
    const both = { ...spec, series: [...spec.series, { ...spec.series[0], column: col("F"), name: "Cond", color: "orange" as const, x: col("E") }] };
    expect(chartWarnings(both, sec)).toEqual(["UV 1_280 and Cond have different units (mAU and mS/cm) but share one side axis. A chart for each may read better."]);
    const backwards = { ...standards, columns: standards.columns.map((c) => (c.id === "A" && c.kind === "number" ? { ...c, values: [...c.values].reverse() } : c)) };
    expect(chartWarnings({ ...xy(startFor(standards, "scatter")), type: "line" }, backwards)).toEqual([
      "BSA doesn't go up row by row, so the line doubles back. A scatter chart may read better.",
    ]);
  });

  it("count cells that aren't numbers, and crowded bars", () => {
    const odd = { ...standards, columns: standards.columns.map((c) => (c.id === "E" ? { ...c, invalid: 2 } : c)) };
    expect(chartWarnings(xy(startFor(standards, "scatter")), odd)).toEqual(["Mean has 2 cells that aren't numbers, so they're left out."]);
    const long = xy(startFor(kinetic, "bar"));
    expect(chartWarnings(long, kinetic)).toEqual(["These 31 bars are crowded. A line may read better."]);
    expect(chartWarnings(xy(startFor(standards, "scatter")), standards)).toEqual([]);
  });
});

describe("column cards and labels", () => {
  it("show a few real values", () => {
    expect(columnSample(standards.columns[0])).toBe("0, 125, 250, 500, …");
    expect(columnSample(samples.columns[0], 2)).toBe("Lysate, Flow-through, …");
  });

  it("read a typed axis label back into its title and unit", () => {
    expect(splitAxisText("Absorbance at 595 nm (AU)")).toEqual({ title: "Absorbance at 595 nm", unit: "AU" });
    expect(splitAxisText(" Time ")).toEqual({ title: "Time", unit: "" });
  });
});

describe("what a chart says about itself", () => {
  it("names a curve's own bottom column", () => {
    const spec = xy(startFor(sec, "line"));
    const own = { ...spec, series: [...spec.series, { ...spec.series[0], column: col("D"), name: "A260", color: "orange" as const, x: col("C") }] };
    expect(describeChart(own, sec)).toMatch(/ A260 is drawn against its own bottom column, UV 2_260 \(ml\), as the instrument recorded it\.$/);
  });

  it("says when error bars are hidden behind their dots, so they don't read as missing", () => {
    const plot = plotChart(xy(startFor(standards, "scatter")), standards, { width: 760, height: 440 });
    expect(plot.notes).toEqual(["2 error bars on Mean are shorter than the dot, so they hide behind it. Show the numbers lists every value."]);
  });
});
