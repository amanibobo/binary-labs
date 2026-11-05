import { describe, expect, it } from "vitest";
import bradfordJson from "@/fixtures/tables/Bradford_2026-10-30.json";
import plateJson from "@/fixtures/tables/plate7_A420.json";
import secJson from "@/fixtures/tables/SEC_trace_141026.json";
import { ChartSpec, checkSpec, CreateChartRequest, MAX_BARS, nextColor, startingSpec, type Series } from "../charts";
import { DataTables, mainTable, rowsNote, type DataTable } from "../data-tables";
import { ColumnId } from "../ids";

// The worker's real output for the three fixture exports: this is the contract between them.
const plate = DataTables.parse(plateJson);
const sec = DataTables.parse(secJson);
const bradford = DataTables.parse(bradfordJson);
const table = (doc: DataTables, name: string): DataTable => {
  const t = doc.tables.find((x) => x.name === name);
  if (t === undefined) throw new Error(name);
  return t;
};
const col = (id: string) => ColumnId.parse(id);

const standards = table(bradford, "Standards");
const base = {
  version: 1 as const,
  type: "scatter" as const,
  x: { column: col("A"), title: "BSA", unit: "µg/mL", min: null, max: null },
  y: { title: "A595", unit: "AU", scale: "linear" as const, min: null, max: null },
  series: [{ column: col("E"), name: "Mean", color: "blue" as const, error: col("F") }],
  legend: "top" as const,
};

describe("the worker's tables", () => {
  it("parse on the web side, columns typed", () => {
    expect(bradford.tables.map((t) => t.name)).toEqual(["Standards", "Samples", "Plate"]);
    expect(table(sec, "Table 1").columns.map((c) => [c.id, c.kind])).toContainEqual(["H", "text"]);
    expect(mainTable(plate)?.columns).toHaveLength(98);
  });

  it("say when only the first rows were kept", () => {
    expect(rowsNote(standards)).toBeNull();
    expect(rowsNote({ ...standards, rows: 20_000, truncated: true, rowsInFile: 85_312 })).toBe("First 20,000 rows of 85,312.");
    expect(rowsNote({ ...standards, rows: 20_000, truncated: true, rowsInFile: null })).toBe("First 20,000 rows.");
  });
});

describe("a chart spec", () => {
  it("accepts a scatter with error bars", () => {
    expect(ChartSpec.safeParse(base).success).toBe(true);
    expect(checkSpec(ChartSpec.parse(base), standards)).toBeNull();
  });

  it.each([
    ["an unknown type", { ...base, type: "pie" }],
    ["a column that isn't a letter", { ...base, x: { ...base.x, column: "A1" } }],
    ["no series", { ...base, series: [] }],
    ["a color outside the palette", { ...base, series: [{ ...base.series[0], color: "red" }] }],
    ["four series on a scatter", { ...base, series: ["B", "C", "D", "E"].map((c) => ({ ...base.series[0], column: c })) }],
    ["a log scale on bars", { ...base, type: "bar", y: { ...base.y, scale: "log" } }],
    ["a range that ends before it starts", { ...base, y: { ...base.y, min: 2, max: 1 } }],
    ["the same column twice", { ...base, series: [base.series[0], { ...base.series[0], color: "orange" }] }],
    ["x plotted against itself", { ...base, series: [{ ...base.series[0], column: "A" }] }],
    ["a blank series name", { ...base, series: [{ ...base.series[0], name: "  " }] }],
  ])("refuses %s", (_name, spec) => {
    expect(ChartSpec.safeParse(spec).success).toBe(false);
  });

  it("refuses columns the table doesn't have or can't plot", () => {
    const spec = ChartSpec.parse(base);
    expect(checkSpec({ ...spec, x: { ...spec.x, column: col("Z") } }, standards)).toBe("Column Z isn't in Standards.");
    const samples = table(bradford, "Samples");
    const onText = ChartSpec.parse({ ...base, x: { ...base.x, column: "A" }, series: [{ ...base.series[0], column: "C", error: null }] });
    expect(checkSpec(onText, samples)).toMatch(/^Sample holds text/);
    expect(checkSpec({ ...onText, type: "bar" }, samples)).toBeNull();
    const errorOnText = ChartSpec.parse({ ...base, x: { ...base.x, column: "B" }, series: [{ ...base.series[0], column: "C", error: "A" }] });
    expect(checkSpec(errorOnText, samples)).toBe("Sample holds text, so it can't be error bars.");
  });

  it("caps bars and needs positives for a log scale", () => {
    const akta = table(sec, "Table 1");
    const bars = ChartSpec.parse({ ...base, type: "bar", series: [{ ...base.series[0], column: "B", error: null }] });
    expect(checkSpec(bars, akta)).toBe(`A bar chart takes up to ${MAX_BARS} bars, and this table has 961 rows. Try a line chart.`);
    const negatives: DataTable = {
      ...standards,
      columns: standards.columns.map((c) => (c.id === "E" && c.kind === "number" ? { ...c, values: c.values.map((v) => (v === null ? null : -v)) } : c)),
    };
    const log = ChartSpec.parse({ ...base, y: { ...base.y, scale: "log" } });
    expect(checkSpec(log, negatives)).toBe("A log scale needs values above zero.");
  });

  it("a create request carries a valid spec", () => {
    const request = { sha256: "a".repeat(64), sheet: "Standards", title: "Curve", spec: { ...base, type: "donut" }, protocolId: null };
    expect(CreateChartRequest.safeParse(request).success).toBe(false);
    expect(CreateChartRequest.safeParse({ ...request, spec: base }).success).toBe(true);
  });
});

describe("a new chart", () => {
  it("starts on the plate read's time and first well, skipping the flat temperature", () => {
    const spec = startingSpec(table(plate, "Table 1"));
    expect(spec?.type).toBe("line");
    expect(spec?.x).toMatchObject({ column: "A", title: "Time", unit: "min" });
    expect(spec?.series).toEqual([{ column: "C", name: "A1", color: "blue", error: null }]);
  });

  it("starts the AKTA trace as volume against absorbance", () => {
    const spec = startingSpec(table(sec, "Table 1"));
    expect(spec).toMatchObject({ type: "line", x: { column: "A", unit: "ml" }, y: { title: "UV 1_280", unit: "mAU" } });
  });

  it("starts names and numbers as bars, and a sheet of text as nothing", () => {
    expect(startingSpec(table(bradford, "Samples"))?.type).toBe("scatter");
    const namesOnly: DataTable = { ...standards, columns: [table(bradford, "Samples").columns[0], standards.columns[1]] };
    expect(startingSpec(namesOnly)).toMatchObject({ type: "bar", x: { column: "A" } });
    expect(startingSpec({ ...standards, columns: [table(bradford, "Samples").columns[0]] })).toBeNull();
  });

  it("gives each new series the first color not in use, never repainting the others", () => {
    const series = (colors: Series["color"][]): Series[] => colors.map((color, i) => ({ column: col("ABCDEF"[i]), name: "s", color, error: null }));
    expect(nextColor([])).toBe("blue");
    expect(nextColor(series(["blue", "orange"]))).toBe("aqua");
    expect(nextColor(series(["orange"]))).toBe("blue");
  });
});
