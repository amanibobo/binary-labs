import { describe, expect, it } from "vitest";
import bioreactorJson from "@/fixtures/tables/Bioreactor_run12.json";
import bradfordJson from "@/fixtures/tables/Bradford_2026-10-30.json";
import elisaJson from "@/fixtures/tables/ELISA_plate3.json";
import plateJson from "@/fixtures/tables/plate7_A420.json";
import secJson from "@/fixtures/tables/SEC_trace_141026.json";
import {
  brokenColumns,
  ChartSpec,
  chartTrouble,
  checkSpec,
  CreateChartRequest,
  MAX_BARS,
  MAX_SERIES,
  nextStyle,
  repairSpec,
  SERIES_COLORS,
  startingHeatmap,

  isXY,
  withType,
  type Series,
  type XYSpec,
} from "../charts";
import { startingChart } from "../chart-guide";
import { DataTables, formatDate, mainTable, rowsNote, type DataTable } from "../data-tables";
import { ColumnId } from "../ids";

// The worker's real output for the fixture exports: this is the contract between them.
const plate = DataTables.parse(plateJson);
const sec = DataTables.parse(secJson);
const bradford = DataTables.parse(bradfordJson);
const bioreactor = DataTables.parse(bioreactorJson);
const elisa = DataTables.parse(elisaJson);
const table = (doc: DataTables, name: string): DataTable => {
  const t = doc.tables.find((x) => x.name === name);
  if (t === undefined) throw new Error(name);
  return t;
};
const col = (id: string) => ColumnId.parse(id);
const xy = (spec: ChartSpec | null): XYSpec => {
  if (spec === null || !isXY(spec)) throw new Error("not an x/y chart");
  return spec;
};

const standards = table(bradford, "Standards");
const akta = table(sec, "Table 1");
const base = {
  version: 1 as const,
  type: "scatter" as const,
  x: { column: col("A"), title: "BSA", unit: "µg/mL", scale: "linear", min: null, max: null },
  y: { title: "A595", unit: "AU", scale: "linear" as const, min: null, max: null },
  series: [{ column: col("E"), name: "Mean", color: "blue" as const, error: col("F") }],
  legend: "top" as const,
};

describe("the worker's tables", () => {
  it("parse on the web side, columns typed", () => {
    expect(bradford.tables.map((t) => t.name)).toEqual(["Standards", "Samples", "Plate"]);
    expect(akta.columns.map((c) => [c.id, c.kind])).toContainEqual(["H", "text"]);
    expect(mainTable(plate)?.columns).toHaveLength(98);
  });

  it("read a day-first log as dates, with the order it assumed noted", () => {
    const [when] = table(bioreactor, "Table 1").columns;
    expect(when).toMatchObject({ kind: "date", time: true, note: "Read as day/month/year." });
    expect(formatDate(when.kind === "date" ? (when.values[0] ?? 0) : 0, true)).toBe("Nov 10, 2026, 09:00");
  });

  it("read a table parsed before dates existed, with no notes", () => {
    const withoutNote = (c: Record<string, unknown>) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "note"));
    const old = { version: 1, cellLimit: 1, tables: [{ ...standards, columns: standards.columns.map(withoutNote) }] };
    expect(DataTables.parse(old).tables[0].columns[0].note).toBeNull();
  });

  it("say when only the first rows were kept", () => {
    expect(rowsNote(standards)).toBeNull();
    expect(rowsNote({ ...standards, rows: 20_000, truncated: true, rowsInFile: 85_312 })).toBe("First 20,000 rows of 85,312.");
    expect(rowsNote({ ...standards, rows: 20_000, truncated: true, rowsInFile: null })).toBe("First 20,000 rows.");
  });
});

describe("a chart spec", () => {
  it("accepts a scatter with error bars, filling in a solid line and the shared x", () => {
    const spec = xy(ChartSpec.parse(base));
    expect(spec.series[0]).toMatchObject({ stroke: "solid", x: null });
    expect(checkSpec(spec, standards)).toBeNull();
  });

  it.each([
    ["an unknown type", { ...base, type: "pie" }],
    ["a column that isn't a letter", { ...base, x: { ...base.x, column: "A1" } }],
    ["no series", { ...base, series: [] }],
    ["a color outside the palette", { ...base, series: [{ ...base.series[0], color: "red" }] }],
    ["four series on a scatter", { ...base, series: ["B", "C", "D", "E"].map((c, i) => ({ ...base.series[0], column: c, color: SERIES_COLORS[i] })) }],
    ["a log scale on bars", { ...base, type: "bar", y: { ...base.y, scale: "log" } }],
    ["a range that ends before it starts", { ...base, y: { ...base.y, min: 2, max: 1 } }],
    ["the same column twice", { ...base, series: [base.series[0], { ...base.series[0], color: "orange" }] }],
    ["x plotted against itself", { ...base, series: [{ ...base.series[0], column: "A" }] }],
    ["a series along a column it plots", { ...base, type: "line", series: [{ ...base.series[0], x: "E" }] }],
    ["bars with their own x", { ...base, type: "bar", series: [{ ...base.series[0], x: "B" }] }],
    ["a dashed scatter", { ...base, series: [{ ...base.series[0], stroke: "dashed" }] }],
    ["two series that look the same", { ...base, series: [base.series[0], { ...base.series[0], column: "B" }] }],
    ["a blank series name", { ...base, series: [{ ...base.series[0], name: "  " }] }],
  ])("refuses %s", (_name, spec) => {
    expect(ChartSpec.safeParse(spec).success).toBe(false);
  });

  it("refuses columns the table doesn't have or can't plot", () => {
    const spec = xy(ChartSpec.parse(base));
    expect(checkSpec({ ...spec, x: { ...spec.x, column: col("Z") } }, standards)).toBe("Column Z isn't in Standards.");
    const samples = table(bradford, "Samples");
    const onText = xy(ChartSpec.parse({ ...base, x: { ...base.x, column: "A" }, series: [{ ...base.series[0], column: "C", error: null }] }));
    expect(checkSpec(onText, samples)).toMatch(/^Sample holds text/);
    expect(checkSpec({ ...onText, type: "bar" }, samples)).toBeNull();
    const errorOnText = ChartSpec.parse({ ...base, x: { ...base.x, column: "B" }, series: [{ ...base.series[0], column: "C", error: "A" }] });
    expect(checkSpec(errorOnText, samples)).toBe("Sample doesn't hold numbers, so it can't be error bars.");
  });

  it("caps bars and needs positives for a log scale", () => {
    const bars = ChartSpec.parse({ ...base, type: "bar", series: [{ ...base.series[0], column: "B", error: null }] });
    expect(checkSpec(bars, akta)).toBe(`A bar chart takes up to ${MAX_BARS} bars, and this table has 961 rows. Try a line chart.`);
    const negatives: DataTable = {
      ...standards,
      columns: standards.columns.map((c) => (c.id === "E" && c.kind === "number" ? { ...c, values: c.values.map((v) => (v === null ? null : -v)) } : c)),
    };
    const log = ChartSpec.parse({ ...base, y: { ...base.y, scale: "log" } });
    expect(checkSpec(log, negatives)).toBe("A log scale needs values above zero.");
  });

  it("lets each AKTA curve read along its own volume column, never a date against a number", () => {
    const spec = ChartSpec.parse({
      ...base,
      type: "line",
      x: { ...base.x, column: "A" },
      series: [
        { column: "B", name: "A280", color: "blue", error: null },
        { column: "F", name: "Conductivity", color: "orange", error: null, x: "E" },
      ],
    });
    expect(checkSpec(spec, akta)).toBeNull();
    const log = table(bioreactor, "Table 1");
    const mixed = ChartSpec.parse({ ...base, type: "line", x: { ...base.x, column: "A" }, series: [{ column: "C", name: "pH", color: "blue", error: null, x: "B" }] });
    expect(checkSpec(mixed, log)).toBe("Temperature (°C) holds numbers and Timestamp holds dates, so they can't share an axis.");
  });

  it("takes twelve lines, the second six dashed, and keeps scatter at three", () => {
    expect(MAX_SERIES).toEqual({ line: 12, scatter: 3, bar: 6 });
    const wells = table(plate, "Table 1").columns.slice(2, 15);
    const series: Series[] = [];
    for (const w of wells.slice(0, 12)) series.push({ column: w.id, name: w.name, ...nextStyle(series, "line"), error: null, x: null });
    expect(series.map((s) => s.stroke)).toEqual([...Array(6).fill("solid"), ...Array(6).fill("dashed")]);
    expect(series.slice(6).map((s) => s.color)).toEqual([...SERIES_COLORS]);
    const line = ChartSpec.parse({ ...base, type: "line", x: { ...base.x, column: "A" }, series });
    expect(checkSpec(line, table(plate, "Table 1"))).toBeNull();
    const thirteen = [...series, { column: wells[12].id, name: "x", color: "blue", stroke: "solid", error: null, x: null }];
    expect(ChartSpec.safeParse({ ...base, type: "line", series: thirteen }).success).toBe(false);
    expect(ChartSpec.safeParse({ ...base, type: "bar", series: series.slice(0, 7).map((s) => ({ ...s, stroke: "solid" })) }).success).toBe(false);
  });

  it("a create request carries a valid spec", () => {
    const request = { sha256: "a".repeat(64), sheet: "Standards", title: "Curve", spec: { ...base, type: "donut" }, protocolId: null };
    expect(CreateChartRequest.safeParse(request).success).toBe(false);
    expect(CreateChartRequest.safeParse({ ...request, spec: base }).success).toBe(true);
  });
});

describe("a plate spec", () => {
  const grid = table(bradford, "Plate");
  const list = table(elisa, "Table 1");
  const kinetic = table(plate, "Table 1");

  it("starts a grid and a list of wells as a plate, and a kinetic read as its curves", () => {
    expect(startingChart(grid)).toEqual({
      version: 1,
      type: "heatmap",
      plate: { size: 96, source: { kind: "grid", rows: "A" } },
      value: { title: "Plate", unit: "", min: null, max: null },
    });
    expect(startingChart(list)).toMatchObject({ type: "heatmap", plate: { size: 96, source: { kind: "wells", well: "A", value: "C" } }, value: { title: "OD450" } });
    expect(startingChart(kinetic)?.type).toBe("line");
    expect(withType(xy(startingChart(kinetic)), "heatmap", kinetic, null)).toMatchObject({ plate: { size: 96, source: { kind: "read", row: 30 } } });
  });

  it("is checked against the table's plate", () => {
    const spec = startingHeatmap(list);
    if (spec === null) throw new Error("not a plate");
    expect(checkSpec(spec, list)).toBeNull();
    expect(checkSpec(spec, akta)).toBe("Table 1 doesn't read as a plate.");
    expect(checkSpec({ ...spec, plate: { ...spec.plate, size: 384 } }, list)).toBe("Table 1 reads as a 96-well plate, not 384.");
    const late = ChartSpec.parse({ version: 1, type: "heatmap", plate: { size: 96, source: { kind: "read", row: 31 } }, value: { title: "", unit: "", min: null, max: null } });
    expect(checkSpec(late, kinetic)).toBe("Table 1 has 31 reads, so read 32 isn't in it.");
    expect(ChartSpec.safeParse({ ...late, plate: { size: 48, source: { kind: "read", row: 0 } } }).success).toBe(false);
  });

  it("switches to and from a plate, going back to the chart it came from", () => {
    const line = xy(startingChart(kinetic));
    const heat = withType(line, "heatmap", kinetic, null);
    expect(withType(heat, "line", kinetic, line)).toEqual(line);
  });
});

describe("switching type", () => {
  it("makes dashed lines solid and recolors any that would then look alike", () => {
    const series: Series[] = [];
    for (const c of ["B", "C", "D", "E", "F", "G", "H"]) series.push({ column: col(c), name: c, ...nextStyle(series, "line"), error: null, x: col("A") });
    const line = xy(ChartSpec.parse({ ...base, type: "line", x: { ...base.x, column: "A" }, series }));
    const scatter = xy(withType(line, "scatter", akta, null));
    expect(scatter.series.every((s) => s.stroke === "solid")).toBe(true);
    expect(new Set(scatter.series.map((s) => s.color)).size).toBe(6);
    const bars = xy(withType(line, "bar", akta, null));
    expect(bars.series.every((s) => s.x === null)).toBe(true);
  });
});

describe("a saved chart whose table was read again", () => {
  const spec = xy(
    ChartSpec.parse({
      ...base,
      type: "line",
      series: [
        { column: "E", name: "Mean", color: "blue", error: "F" },
        { column: "B", name: "Rep 1", color: "orange", error: null },
      ],
    }),
  );
  const lost: DataTable = { ...standards, columns: standards.columns.filter((c) => c.id !== "B" && c.id !== "F") };

  it("names the columns that went", () => {
    expect(brokenColumns(spec, lost)).toEqual([
      { id: "F", name: "Mean's error bars" },
      { id: "B", name: "Rep 1" },
    ]);
    expect(chartTrouble({ sheet: "Standards", spec }, [lost])).toBe(
      "The file was read again, and Mean's error bars (column F) and Rep 1 (column B) aren't in Standards as before.",
    );
    expect(chartTrouble({ sheet: "Gone", spec }, [lost])).toBe("This chart was made from Gone, which isn't in the file any more.");
    expect(chartTrouble({ sheet: "Standards", spec }, [standards])).toBeNull();
  });

  it("is mended by dropping what went", () => {
    const mended = xy(repairSpec(spec, lost));
    expect(mended.series).toMatchObject([{ column: "E", error: null }]);
    expect(checkSpec(mended, lost)).toBeNull();
  });
});

describe("a new chart", () => {
  it("starts on the plate read's time and its lowest, middle and highest wells, skipping the flat temperature", () => {
    const spec = xy(startingChart(table(plate, "Table 1")));
    expect(spec.type).toBe("line");
    expect(spec.x).toMatchObject({ column: "A", title: "Time", unit: "min" });
    expect(spec.series.map((s) => s.column)).toEqual(["C", "AU", "CJ"]);
  });

  it("starts the AKTA trace as volume against absorbance", () => {
    expect(startingChart(akta)).toMatchObject({ type: "line", x: { column: "A", unit: "ml" }, y: { title: "UV 1_280", unit: "mAU" } });
  });

  it("starts a dated log with time along x", () => {
    expect(startingChart(table(bioreactor, "Table 1"))).toMatchObject({ type: "line", x: { column: "A", title: "Timestamp" }, series: [{ column: "C" }] });
  });

  it("starts names and numbers as bars, and a sheet of text as nothing", () => {
    expect(startingChart(table(bradford, "Samples"))).toMatchObject({ type: "bar", x: { column: "A" }, series: [{ column: "C" }] });
    const namesOnly: DataTable = { ...standards, columns: [table(bradford, "Samples").columns[0], standards.columns[1]] };
    expect(startingChart(namesOnly)).toMatchObject({ type: "bar", x: { column: "A" } });
    expect(startingChart({ ...standards, columns: [table(bradford, "Samples").columns[0]] })).toBeNull();
  });

  it("gives each new series the first style not in use, never repainting the others", () => {
    const series = (colors: Series["color"][]): Series[] =>
      colors.map((color, i) => ({ column: col("ABCDEF"[i]), name: "s", color, stroke: "solid", error: null, x: null }));
    expect(nextStyle([], "line")).toEqual({ color: "blue", stroke: "solid" });
    expect(nextStyle(series(["blue", "orange"]), "line")).toEqual({ color: "aqua", stroke: "solid" });
    expect(nextStyle(series(["orange"]), "bar")).toEqual({ color: "blue", stroke: "solid" });
    expect(nextStyle(series([...SERIES_COLORS]), "line")).toEqual({ color: "blue", stroke: "dashed" });
  });
});
