import { z } from "zod";
import {
  axisColumns,
  columnLabel,
  findColumn,
  isBookkeepingColumn,
  isMeanColumn,
  isSpreadColumn,
  numberColumns,
  spreadFor,
  type AxisColumn,
  type DataColumn,
  type DataTable,
  type NumberColumn,
} from "./data-tables";
import { formatValue } from "./numbers";
import { ChartId, ColumnId, ProtocolId, ProtocolVersionId, Sha256, UserId, type LocationId } from "./ids";
import { PLATE_SHAPE, plateLayout, PlateSize, PlateSource, startingSource, type PlateLayout } from "./plates";
import { Source } from "./replicates";
import { categories, GRID_MAX, startingGridColumns } from "./grids";

// decisions.md, "data sheet to chart". A chart names a file by content, one of its tables, and
// this spec; db/migrations/0020_charts_and_video_steps.sql checks the same structure in
// chart_spec_ok.

// Six hues from the dataviz reference palette, in an order that passes its colorblind and
// normal-vision checks on our light and dark surfaces. Yellow is left out because amber means
// "Check this", and red because it reads as an error. The dark steps are the same hues stepped
// for the dark surface. globals.css carries them as --chart-<slot>; a test checks they agree.
export const SERIES_COLORS = ["blue", "orange", "aqua", "violet", "magenta", "green"] as const;
export const SeriesColor = z.enum(SERIES_COLORS);
export type SeriesColor = z.infer<typeof SeriesColor>;

export const PALETTE = {
  blue: { name: "Blue", light: "#2a78d6", dark: "#3987e5" },
  orange: { name: "Orange", light: "#eb6834", dark: "#d95926" },
  aqua: { name: "Aqua", light: "#1baf7a", dark: "#199e70" },
  violet: { name: "Violet", light: "#6250d6", dark: "#9085e9" },
  magenta: { name: "Magenta", light: "#e87ba4", dark: "#d55181" },
  green: { name: "Green", light: "#008300", dark: "#008300" },
} satisfies Record<SeriesColor, { name: string; light: string; dark: string }>;

// Past six lines the hues come round again dashed, with hollow markers, rather than adding a
// hue the colorblind checks can't pass (decisions.md, "more than six series").
export const STROKES = ["solid", "dashed"] as const;
export const Stroke = z.enum(STROKES);
export type Stroke = z.infer<typeof Stroke>;

// Charts of columns as the sheet has them (line, scatter, bar), a plate heatmap, and charts that
// summarize repeats (decisions.md, "charts round 1"): groups as bars or boxes with every repeat,
// a scatter of means with a fitted line (a standard curve), a line with a shaded spread, a
// dose-response curve and a histogram.
export const CHART_TYPES = ["line", "scatter", "bar", "heatmap", "grid", "groups", "curve", "band", "dose", "histogram"] as const;
export const ChartType = z.enum(CHART_TYPES);
export type ChartType = z.infer<typeof ChartType>;

export const XY_TYPES = ["line", "scatter", "bar"] as const;
export const XYType = z.enum(XY_TYPES);
export type XYType = z.infer<typeof XYType>;

export const LEGEND_POSITIONS = ["top", "right", "bottom"] as const;
export const LegendPosition = z.enum(LEGEND_POSITIONS);
export type LegendPosition = z.infer<typeof LegendPosition>;

// Scatter puts any two series side by side, and only the first three hues stay apart that way.
// Lines take every hue twice, solid then dashed. Bars have no second style that reads at bar
// widths, so they stop at the six hues.
export const MAX_SERIES = { line: 12, scatter: 3, bar: 6 } satisfies Record<XYType, number>;
const SERIES_MAX = Math.max(...Object.values(MAX_SERIES));
// Past this a bar chart's labels can't be read; a line chart reads the same data.
export const MAX_BARS = 60;

// Runs a chart draws beside its own file.
export const MAX_OTHER_RUNS = 11;

const AxisText = z.string().trim().max(80);
const Unit = z.string().trim().max(24);
const Bound = z.number().finite().nullable();

export const Series = z.object({
  column: ColumnId,
  name: z.string().trim().min(1, "Name every series.").max(80),
  color: SeriesColor,
  stroke: Stroke.default("solid"),
  // A column of ± values drawn as error bars.
  error: ColumnId.nullable(),
  // This series' own column along x, for exports that give each curve its own (AKTA, UNICORN);
  // null shares the chart's.
  x: ColumnId.nullable().default(null),
});
export type Series = z.infer<typeof Series>;

const Scale = z.enum(["linear", "log"]);

const XYShape = z.object({
  version: z.literal(1),
  type: XYType,
  // Old specs have no x scale and keep a linear one.
  x: z.object({ column: ColumnId, title: AxisText, unit: Unit, scale: Scale.default("linear"), min: Bound, max: Bound }),
  y: z.object({ title: AxisText, unit: Unit, scale: z.enum(["linear", "log"]), min: Bound, max: Bound }),
  series: z.array(Series).min(1, "Pick a column to plot.").max(SERIES_MAX, `A chart takes up to ${SERIES_MAX} series.`),
  legend: LegendPosition,
  // Other files drawn with the same columns (lib/runs.ts), beside the chart's own; never bars.
  runs: z
    .array(Sha256)
    .max(MAX_OTHER_RUNS, `A chart takes up to ${MAX_OTHER_RUNS} other runs.`)
    .refine((r) => new Set(r).size === r.length, "Each run goes on once.")
    .optional(),
});
export type XYSpec = z.infer<typeof XYShape>;

const HeatmapShape = z.object({
  version: z.literal(1),
  type: z.literal("heatmap"),
  plate: z.object({ size: PlateSize, source: PlateSource }),
  // What the colors stand for, on the legend's scale; blank bounds fit the wells.
  value: z.object({ title: AxisText, unit: Unit, min: Bound, max: Bound }),
});
export type HeatmapSpec = z.infer<typeof HeatmapShape>;

// A heatmap of any two columns that sort the rows (lib/grids.ts): `rows` down the side,
// `columns` across, each square the mean of `measure` over the rows with that pair.
const GridShape = z.object({
  version: z.literal(1),
  type: z.literal("grid"),
  rows: ColumnId,
  columns: ColumnId,
  measure: ColumnId,
  value: z.object({ title: AxisText, unit: Unit, min: Bound, max: Bound }),
});
export type GridSpec = z.infer<typeof GridShape>;

// How much repeats vary, as error bars or a band: the standard deviation, the standard error of
// the mean, or the 95% confidence interval of the mean (t-based).
export const SPREADS = ["sd", "sem", "ci"] as const;
export const Spread = z.enum(SPREADS);
export type Spread = z.infer<typeof Spread>;

const SummaryAxis = z.object({ title: AxisText, unit: Unit, scale: Scale, min: Bound, max: Bound });
export type SummaryAxis = z.infer<typeof SummaryAxis>;

// The test a groups chart names; never chosen silently (the builder starts on the one that
// fits and says why). "control" is each group against the control, Welch t-tests with Holm's
// correction.
export const TESTS = ["none", "welch", "anova", "control"] as const;
export const TestChoice = z.enum(TESTS);
export type TestChoice = z.infer<typeof TestChoice>;

const Repeats = { source: Source, spread: Spread, points: z.boolean(), blank: z.boolean() };

const GroupsShape = z.object({
  version: z.literal(1),
  type: z.literal("groups"),
  mark: z.enum(["bar", "box"]),
  ...Repeats,
  test: TestChoice,
  // The group the others are compared with, by its label.
  control: z.string().max(80).nullable(),
  // Stars over the groups, only ever with the test named under the chart.
  marks: z.boolean(),
  x: z.object({ title: AxisText }),
  y: SummaryAxis,
});
export type GroupsSpec = z.infer<typeof GroupsShape>;

// Unknown samples read off a standard curve: the layout's samples, or another sheet of the file.
export const Unknowns = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("layout") }),
  z.object({ kind: z.literal("table"), table: z.string().min(1).max(200), label: ColumnId, value: ColumnId, dilution: ColumnId.nullable() }),
]);
export type Unknowns = z.infer<typeof Unknowns>;

const CurveShape = z.object({
  version: z.literal(1),
  type: z.literal("curve"),
  ...Repeats,
  fit: z.enum(["none", "line", "origin"]),
  unknowns: Unknowns.nullable(),
  x: SummaryAxis,
  y: SummaryAxis,
});
export type CurveSpec = z.infer<typeof CurveShape>;

const BandShape = z.object({
  version: z.literal(1),
  type: z.literal("band"),
  ...Repeats,
  // A shaded band of the spread, or error bars at each point.
  band: z.boolean(),
  x: SummaryAxis,
  y: SummaryAxis,
  legend: LegendPosition,
});
export type BandSpec = z.infer<typeof BandShape>;

const DoseShape = z.object({
  version: z.literal(1),
  type: z.literal("dose"),
  ...Repeats,
  // The curve is fitted to every repeat, or to the means.
  fit: z.enum(["points", "means"]),
  x: SummaryAxis,
  y: SummaryAxis,
});
export type DoseSpec = z.infer<typeof DoseShape>;

const HistogramShape = z.object({
  version: z.literal(1),
  type: z.literal("histogram"),
  column: ColumnId,
  // The bins' width; null picks one from the data.
  bin: z.number().finite().positive().nullable(),
  x: z.object({ title: AxisText, unit: Unit, min: Bound, max: Bound }),
  y: z.object({ title: AxisText }),
});
export type HistogramSpec = z.infer<typeof HistogramShape>;

export type SummarySpec = GroupsSpec | CurveSpec | BandSpec | DoseSpec;

export const ChartSpec = z.union([XYShape, HeatmapShape, GridShape, GroupsShape, CurveShape, BandShape, DoseShape, HistogramShape]).superRefine((spec, ctx) => {
  const problem = specProblem(spec);
  if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
});
export type ChartSpec = z.infer<typeof ChartSpec>;

export function isHeatmap(spec: ChartSpec): spec is HeatmapSpec {
  return spec.type === "heatmap";
}

export function isGrid(spec: ChartSpec): spec is GridSpec {
  return spec.type === "grid";
}

// The charts colored along a scale: a plate and a heatmap of two columns.
export type ScaledSpec = HeatmapSpec | GridSpec;

export function isScaled(spec: ChartSpec): spec is ScaledSpec {
  return spec.type === "heatmap" || spec.type === "grid";
}

export function isXY(spec: ChartSpec): spec is XYSpec {
  return spec.type === "line" || spec.type === "scatter" || spec.type === "bar";
}

export function isSummary(spec: ChartSpec): spec is SummarySpec {
  return spec.type === "groups" || spec.type === "curve" || spec.type === "band" || spec.type === "dose";
}

function rangeProblem(axes: readonly { min: number | null; max: number | null; scale?: "linear" | "log" }[]): string | null {
  for (const axis of axes) {
    if (axis.min !== null && axis.max !== null && axis.min >= axis.max) return "Each range has to start below where it ends.";
    if (axis.scale === "log" && axis.min !== null && axis.min <= 0) return "A log scale starts above zero.";
  }
  return null;
}

const sameStyle = (a: Series, b: Series) => a.color === b.color && a.stroke === b.stroke;

// What the spec alone rules out; checkSpec below also needs the table.
export function specProblem(spec: ChartSpec): string | null {
  switch (spec.type) {
    case "heatmap":
    case "grid": {
      const { min, max } = spec.value;
      if (min !== null && max !== null && min >= max) return "The color scale has to start below where it ends.";
      return null;
    }
    case "groups":
      if (spec.y.scale === "log" && spec.mark === "bar") return "Bars start at zero, so they can't use a log scale.";
      return rangeProblem([spec.y]);
    case "curve":
    case "band":
      return rangeProblem([spec.x, spec.y]);
    case "dose":
      if (spec.x.scale !== "log") return "A dose-response curve runs along a log scale of the dose.";
      return rangeProblem([spec.x, spec.y]);
    case "histogram":
      return rangeProblem([spec.x]);
    case "line":
    case "scatter":
    case "bar":
      return xyProblem(spec);
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}

function xyProblem(spec: XYSpec): string | null {
  if (spec.type === "bar" && (spec.runs?.length ?? 0) > 0) return "Bars can't draw other runs. A line or scatter chart can.";
  if (spec.series.length > MAX_SERIES[spec.type]) {
    return spec.type === "scatter"
      ? "A scatter chart takes up to three series."
      : `A ${spec.type} chart takes up to ${MAX_SERIES[spec.type]} series.`;
  }
  if (spec.type === "bar" && spec.y.scale === "log") return "Bars start at zero, so they can't use a log scale.";
  if (spec.type === "bar" && spec.x.scale === "log") return "Bars sit side by side, so they have no log scale along the bottom.";
  if (spec.y.scale === "log" && spec.y.min !== null && spec.y.min <= 0) return "A log scale starts above zero.";
  if (spec.x.scale === "log" && spec.x.min !== null && spec.x.min <= 0) return "A log scale starts above zero.";
  for (const axis of [spec.x, spec.y]) {
    if (axis.min !== null && axis.max !== null && axis.min >= axis.max) return "Each range has to start below where it ends.";
  }
  const columns = spec.series.map((s) => s.column);
  if (new Set(columns).size !== columns.length) return "Each column can be plotted once.";
  if (columns.includes(spec.x.column)) return "A column can't be plotted against itself.";
  for (const s of spec.series) {
    if (s.x !== null && spec.type === "bar") return "Bars share one column along x.";
    if (s.x !== null && columns.includes(s.x)) return "A column can't be plotted against itself.";
    if (s.stroke === "dashed" && spec.type !== "line") return "Only lines can be dashed.";
  }
  if (spec.series.some((s, i) => spec.series.findIndex((q) => sameStyle(q, s)) !== i)) {
    return "Two series look the same. Give one another color or line.";
  }
  return null;
}

const HOLDS = { number: "numbers", date: "dates", text: "text" } satisfies Record<DataColumn["kind"], string>;

// The first thing wrong with a spec for this table, in words, or null when it can be drawn.
// `tables` is the whole file, for a standard curve that reads its unknowns from another sheet.
export function checkSpec(spec: ChartSpec, table: DataTable, tables: readonly DataTable[] = [table]): string | null {
  switch (spec.type) {
    case "heatmap":
      return checkHeatmap(spec, table);
    case "grid":
      return checkGrid(spec, table);
    case "line":
    case "scatter":
    case "bar":
      return checkXY(spec, table);
    case "histogram": {
      const c = findColumn(table, spec.column);
      if (c === undefined) return missing(spec.column, table);
      if (c.kind !== "number") return `${columnLabel(c)} holds ${HOLDS[c.kind]}, so it can't be counted into bins.`;
      if (c.values.filter((v) => v !== null).length < 2) return `${columnLabel(c)} has fewer than 2 numbers.`;
      return null;
    }
    case "groups":
    case "curve":
    case "band":
    case "dose":
      return checkSource(spec.source, table) ?? (spec.type === "curve" ? checkUnknowns(spec, tables) : null);
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}

function checkSource(source: Source, table: DataTable): string | null {
  const number = (id: ColumnId): string | null => {
    const c = findColumn(table, id);
    if (c === undefined) return missing(id, table);
    return c.kind === "number" ? null : `${columnLabel(c)} holds ${HOLDS[c.kind]}, so it can't be a measurement.`;
  };
  switch (source.kind) {
    case "columns":
      for (const id of source.columns) {
        const problem = number(id);
        if (problem !== null) return problem;
      }
      return null;
    case "rows": {
      if (findColumn(table, source.key) === undefined) return missing(source.key, table);
      for (const id of source.series.flatMap((s) => s.values)) {
        const problem = number(id);
        if (problem !== null) return problem;
      }
      return null;
    }
    case "long":
      if (findColumn(table, source.key) === undefined) return missing(source.key, table);
      return number(source.value);
    case "plate": {
      const plate: HeatmapSpec = { version: 1, type: "heatmap", plate: { size: source.layout.size, source: source.plate }, value: { title: "", unit: "", min: null, max: null } };
      return checkHeatmap(plate, table);
    }
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function checkUnknowns(spec: CurveSpec, tables: readonly DataTable[]): string | null {
  const u = spec.unknowns;
  if (u === null) return null;
  if (u.kind === "layout") return spec.source.kind === "plate" ? null : "Only a plate's layout has samples to read.";
  const other = tables.find((t) => t.name === u.table);
  if (other === undefined) return `There's no sheet called ${u.table} in this file.`;
  if (findColumn(other, u.label) === undefined) return missing(u.label, other);
  const value = findColumn(other, u.value);
  if (value === undefined) return missing(u.value, other);
  if (value.kind !== "number") return `${columnLabel(value)} doesn't hold numbers.`;
  return null;
}

function missing(id: ColumnId, table: DataTable): string {
  return `Column ${id} isn't in ${table.name}.`;
}

function checkXY(spec: XYSpec, table: DataTable): string | null {
  const x = findColumn(table, spec.x.column);
  if (x === undefined) return missing(spec.x.column, table);
  if (spec.type !== "bar" && x.kind === "text") {
    return `${columnLabel(x)} holds text. Pick a bar chart, or a column of numbers or dates for x.`;
  }
  for (const s of spec.series) {
    const column = findColumn(table, s.column);
    if (column === undefined) return missing(s.column, table);
    if (column.kind !== "number") return `${columnLabel(column)} holds ${HOLDS[column.kind]}, so it can't be plotted.`;
    if (s.error !== null) {
      const error = findColumn(table, s.error);
      if (error === undefined) return missing(s.error, table);
      if (error.kind !== "number") return `${columnLabel(error)} doesn't hold numbers, so it can't be error bars.`;
    }
    if (s.x !== null) {
      const own = findColumn(table, s.x);
      if (own === undefined) return missing(s.x, table);
      if (own.kind !== x.kind) {
        return `${columnLabel(own)} holds ${HOLDS[own.kind]} and ${columnLabel(x)} holds ${HOLDS[x.kind]}, so they can't share an axis.`;
      }
    }
  }
  if (spec.type === "bar") {
    const bars = x.values.filter((v) => v !== null).length;
    if (bars > MAX_BARS) return `A bar chart takes up to ${MAX_BARS} bars, and this table has ${bars} rows. Try a line chart.`;
  }
  if (spec.x.scale === "log") {
    if (x.kind !== "number") return "Only numbers can go on a log scale.";
    const row = x.values.findIndex((v) => v !== null && v <= 0);
    const v = row < 0 ? null : x.values[row];
    if (v !== null && v !== undefined) {
      return `${columnLabel(x)} has ${formatValue(v)} in row ${row + 1}, and a log scale has no place for zero or less. Leave the log scale off, or chart only the rows above zero.`;
    }
  }
  if (spec.y.scale === "log") {
    const positive = spec.series.some((s) => {
      const column = findColumn(table, s.column);
      return column?.kind === "number" && column.values.some((v) => v !== null && v > 0);
    });
    if (!positive) return "A log scale needs values above zero.";
  }
  return null;
}

function checkHeatmap(spec: HeatmapSpec, table: DataTable): string | null {
  const layout = plateLayout(table);
  const source = spec.plate.source;
  if (layout === null) return `${table.name} doesn't read as a plate.`;
  if (layout.size !== spec.plate.size) return `${table.name} reads as a ${layout.size}-well plate, not ${spec.plate.size}.`;
  switch (source.kind) {
    case "grid":
      if (layout.kind !== "grid") return `${table.name} isn't laid out as a plate grid any more.`;
      if (layout.rows.id !== source.rows) return `The plate's row letters aren't in column ${source.rows} any more.`;
      return null;
    case "wells": {
      if (layout.kind !== "wells") return `${table.name} doesn't list its wells one per row any more.`;
      if (layout.well.id !== source.well) return `Column ${source.well} doesn't hold the wells any more.`;
      const value = findColumn(table, source.value);
      if (value === undefined) return missing(source.value, table);
      if (value.kind !== "number") return `${columnLabel(value)} doesn't hold numbers.`;
      return null;
    }
    case "read":
      if (layout.kind !== "read") return `${table.name} doesn't have a column per well any more.`;
      if (source.row >= table.rows) return `${table.name} has ${table.rows} reads, so read ${source.row + 1} isn't in it.`;
      return null;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function checkGrid(spec: GridSpec, table: DataTable): string | null {
  for (const [id, side] of [[spec.rows, "down the side"], [spec.columns, "across the top"]] as const) {
    const c = findColumn(table, id);
    if (c === undefined) return missing(id, table);
    const kinds = categories(c).names.length;
    if (kinds < 2) return `${columnLabel(c)} has only one kind of row, so there's nothing to set ${side}.`;
    if (kinds > GRID_MAX) return `${columnLabel(c)} has ${kinds} different values, too many for a heatmap (up to ${GRID_MAX}).`;
  }
  if (spec.rows === spec.columns) return "Pick two different columns for the side and the top.";
  const m = findColumn(table, spec.measure);
  if (m === undefined) return missing(spec.measure, table);
  if (m.kind !== "number") return `${columnLabel(m)} holds ${HOLDS[m.kind]}, so it can't color the squares.`;
  if (spec.measure === spec.rows || spec.measure === spec.columns) return `${columnLabel(m)} already sorts the rows, so it can't color the squares too.`;
  return null;
}

// The style a new series gets: the first hue nobody has, solid, then the hues again dashed.
export function nextStyle(series: readonly Series[], type: XYType): { color: SeriesColor; stroke: Stroke } {
  const strokes: readonly Stroke[] = type === "line" ? STROKES : ["solid"];
  for (const stroke of strokes) {
    for (const color of SERIES_COLORS) {
      if (!series.some((s) => s.color === color && s.stroke === stroke)) return { color, stroke };
    }
  }
  return { color: SERIES_COLORS[series.length % SERIES_COLORS.length], stroke: "solid" };
}

function isIncreasing(column: AxisColumn): boolean {
  let last = -Infinity;
  for (const v of column.values) {
    if (v === null) continue;
    if (v < last) return false;
    last = v;
  }
  return true;
}

// How an x/y chart of a table starts before anyone picks (startingColumns): a line when x only
// goes up, dots when it doesn't, bars along names, with the measured column's spreads as error
// bars when the table has them. lib/chart-guide.ts picks the kind of chart a new one starts as;
// this is also where a type switch or a mended chart lands. Null when there's nothing to plot.
export function startingXY(table: DataTable): XYSpec | null {
  const start = startingColumns(table);
  if (start === null) return null;
  const { x, y } = start;
  const type: XYType = x.kind === "text" ? "bar" : isIncreasing(x) ? "line" : "scatter";
  return {
    version: 1,
    type,
    x: { column: x.id, title: x.name, unit: x.unit ?? "", scale: "linear", min: null, max: null },
    y: { title: y.name, unit: y.unit ?? "", scale: "linear", min: null, max: null },
    series: [{ column: y.id, name: y.name, color: SERIES_COLORS[0], stroke: "solid", error: spreadFor(table, y)?.id ?? null, x: null }],
    legend: "top",
  };
}

export function startingHeatmap(table: DataTable, layout: PlateLayout | null = plateLayout(table)): HeatmapSpec | null {
  if (layout === null) return null;
  const source = startingSource(layout, table);
  const named =
    source.kind === "wells" ? findColumn(table, source.value) : layout.kind === "read" ? layout.wells[0]?.column : layout.kind === "grid" ? layout.columns[0]?.column : undefined;
  const unit = named?.kind === "number" ? (named.unit ?? "") : "";
  const title = source.kind === "wells" && named !== undefined ? named.name : table.name;
  return { version: 1, type: "heatmap", plate: { size: layout.size, source }, value: { title, unit, min: null, max: null } };
}

// The spec as another type. Switching between a plate and an x/y chart goes back to what the
// other one was (`other`), or to how that kind of chart of this table starts. Series keep their
// colors; leaving a line chart makes dashed series solid, recoloring any that then look alike.
export function withType(spec: ChartSpec, type: XYType | "heatmap", table: DataTable, other: ChartSpec | null): ChartSpec {
  if (type === "heatmap") {
    if (spec.type === "heatmap") return spec;
    return (other?.type === "heatmap" ? other : startingHeatmap(table)) ?? spec;
  }
  const base = isXY(spec) ? spec : other !== null && isXY(other) ? other : startingXY(table);
  if (base === null) return spec;
  const series: Series[] = [];
  for (const s of base.series) {
    const moved = { ...s, x: type === "bar" ? null : s.x, stroke: type === "line" ? s.stroke : ("solid" as const) };
    series.push(series.some((q) => sameStyle(q, moved)) ? { ...moved, ...nextStyle(series, type) } : moved);
  }
  return {
    ...base,
    type,
    x: type === "bar" ? { ...base.x, scale: "linear" } : base.x,
    y: type === "bar" ? { ...base.y, scale: "linear" } : base.y,
    series,
    runs: type === "bar" ? undefined : base.runs,
  };
}

// The columns a summary chart reads.
function sourceColumns(source: Source): ColumnId[] {
  switch (source.kind) {
    case "columns":
      return source.columns;
    case "rows":
      return [source.key, ...source.series.flatMap((s) => s.values)];
    case "long":
      return [source.key, source.value];
    case "plate":
      return source.plate.kind === "wells" ? [source.plate.well, source.plate.value] : source.plate.kind === "grid" ? [source.plate.rows] : [];
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

// The columns a saved chart names that its table no longer has, or no longer holds the right
// kind of thing in, each with the name the chart gave it. A table read again by a newer parser
// can lose or retype a column; the chart says which (decisions.md, "re-parsing tables").
export function brokenColumns(spec: ChartSpec, table: DataTable): { id: ColumnId; name: string }[] {
  const out: { id: ColumnId; name: string }[] = [];
  const want = (id: ColumnId | null, name: string, ok: (c: DataColumn) => boolean) => {
    if (id === null) return;
    const c = findColumn(table, id);
    if ((c === undefined || !ok(c)) && !out.some((o) => o.id === id)) out.push({ id, name });
  };
  if (spec.type === "heatmap") {
    const s = spec.plate.source;
    if (s.kind === "grid") want(s.rows, "the row letters", (c) => c.kind === "text");
    if (s.kind === "wells") {
      want(s.well, "the wells", (c) => c.kind === "text");
      want(s.value, spec.value.title || "the values", (c) => c.kind === "number");
    }
    return out;
  }
  if (spec.type === "histogram") {
    want(spec.column, spec.x.title || "the values", (c) => c.kind === "number");
    return out;
  }
  if (spec.type === "grid") {
    want(spec.rows, "the side", () => true);
    want(spec.columns, "the top", () => true);
    want(spec.measure, spec.value.title || "the values", (c) => c.kind === "number");
    return out;
  }
  if (isSummary(spec)) {
    for (const id of sourceColumns(spec.source)) want(id, findColumn(table, id)?.name ?? `column ${id}`, () => checkSource(spec.source, table) === null);
    return out;
  }
  const isAxis = (c: DataColumn) => spec.type === "bar" || c.kind !== "text";
  want(spec.x.column, spec.x.title || "x", isAxis);
  for (const s of spec.series) {
    want(s.column, s.name, (c) => c.kind === "number");
    want(s.error, `${s.name}'s error bars`, (c) => c.kind === "number");
    want(s.x, `${s.name}'s x`, isAxis);
  }
  return out;
}

// What a saved chart says when the file's tables no longer fit it, or null when they do.
export function chartTrouble(chart: { sheet: string; spec: ChartSpec }, tables: readonly DataTable[]): string | null {
  const table = tables.find((t) => t.name === chart.sheet);
  if (table === undefined) return `This chart was made from ${chart.sheet}, which isn't in the file any more.`;
  const broken = brokenColumns(chart.spec, table);
  if (broken.length === 0) return checkSpec(chart.spec, table);
  const names = broken.map((b) => `${b.name} (column ${b.id})`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `The file was read again, and ${list} ${broken.length === 1 ? "isn't" : "aren't"} in ${table.name} as before.`;
}

// A saved chart mended to fit its table: series whose column went are dropped, references to
// columns that went are cleared, and a lost x is the table's first. Null when nothing is left.
export function repairSpec(spec: ChartSpec, table: DataTable): ChartSpec | null {
  if (spec.type === "heatmap") return checkSpec(spec, table) === null ? spec : startingHeatmap(table);
  if (spec.type === "grid") return checkSpec(spec, table) === null ? spec : startingGrid(table);
  if (!isXY(spec)) return checkSpec(spec, table) === null ? spec : null;
  const ok = (id: ColumnId | null, kinds: readonly DataColumn["kind"][]) => {
    if (id === null) return false;
    const c = findColumn(table, id);
    return c !== undefined && kinds.includes(c.kind);
  };
  const axisKinds = spec.type === "bar" ? (["number", "date", "text"] as const) : (["number", "date"] as const);
  const start = startingXY(table);
  const x = ok(spec.x.column, axisKinds) ? spec.x : start?.x;
  if (x === undefined) return null;
  const series = spec.series
    .filter((s) => ok(s.column, ["number"]) && s.column !== x.column)
    .map((s) => ({ ...s, error: ok(s.error, ["number"]) ? s.error : null, x: ok(s.x, axisKinds) ? s.x : null }));
  if (series.length === 0) return start;
  const mended = { ...spec, x, series };
  return checkSpec(mended, table) === null ? mended : start;
}

export function startingGrid(table: DataTable): GridSpec | null {
  const picked = startingGridColumns(table);
  if (picked === null) return null;
  const measure = findColumn(table, picked.measure);
  return { version: 1, type: "grid", ...picked, value: { title: measure?.name ?? "", unit: measure?.kind === "number" ? (measure.unit ?? "") : "", min: null, max: null } };
}

export function plateShape(spec: HeatmapSpec): { rows: number; columns: number } {
  return PLATE_SHAPE[spec.plate.size];
}

// A column that hardly moves, like a plate reader's temperature log, is a poor first plot.
function isFlat(column: NumberColumn): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of column.values) {
    if (v === null) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return !Number.isFinite(lo) || hi - lo <= 0.01 * Math.max(Math.abs(lo), Math.abs(hi));
}

// The column a chart of this table measures first, other than x: a mean when there is one,
// else the first that moves, passing over spreads (they're error bars) and columns that number
// or dilute the rows.
export function startingMeasure(table: DataTable, x: DataColumn | null): NumberColumn | null {
  const all = numberColumns(table).filter((c) => c.id !== x?.id);
  const readings = all.filter((c) => !isSpreadColumn(c) && !isBookkeepingColumn(c));
  return readings.find(isMeanColumn) ?? readings.find((c) => !isFlat(c)) ?? readings[0] ?? all[0] ?? null;
}

function barNames(table: DataTable): DataColumn | null {
  const names = table.columns.find((c) => c.kind === "text");
  return names !== undefined && names.values.filter((v) => v !== null).length <= MAX_BARS ? names : null;
}

// A table whose first column names its rows ("Sample": Lysate, Wash, …) starts as bars of
// them; otherwise its first numbers or dates column runs along x.
function startingColumns(table: DataTable): { x: DataColumn; y: NumberColumn } | null {
  const names = barNames(table);
  if (names !== null && table.columns[0]?.id === names.id) {
    const y = startingMeasure(table, names);
    if (y !== null) return { x: names, y };
  }
  const [first] = axisColumns(table);
  if (first !== undefined) {
    const y = startingMeasure(table, first);
    if (y !== null) return { x: first, y };
  }
  const y = startingMeasure(table, null);
  return y !== null && names !== null ? { x: names, y } : null;
}

export const TITLE_MAX = 200;
const Title = z.string().trim().min(1, "Give the chart a title.").max(TITLE_MAX);
const Sheet = z.string().min(1).max(200);

export const CreateChartRequest = z.object({
  sha256: Sha256,
  sheet: Sheet,
  title: Title,
  spec: ChartSpec,
  protocolId: ProtocolId.nullable(),
});
export type CreateChartRequest = z.input<typeof CreateChartRequest>;

// basedOn is the updatedAt the editor opened, so a save over someone else's is caught.
export const SaveChartRequest = CreateChartRequest.omit({ sha256: true }).extend({ basedOn: z.string().min(1).max(64) });
export type SaveChartRequest = z.input<typeof SaveChartRequest>;

export type SavedChart = {
  id: ChartId;
  sha256: Sha256;
  sheet: string;
  title: string;
  spec: ChartSpec;
  protocolId: ProtocolId | null;
  // The protocol's version when the chart was last saved on it (set by the database).
  protocolVersionId: ProtocolVersionId | null;
  createdBy: UserId | null;
  createdAt: string;
  updatedAt: string;
};

export const CHART_COLUMNS = "id, sha256, sheet, title, spec, protocol_id, protocol_version_id, created_by, created_at, updated_at";

export const ChartRow = z
  .object({
    id: ChartId,
    sha256: Sha256,
    sheet: z.string(),
    title: z.string(),
    spec: ChartSpec,
    protocol_id: ProtocolId.nullable(),
    protocol_version_id: ProtocolVersionId.nullable().default(null),
    created_by: UserId.nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform(
    (r): SavedChart => ({
      id: r.id,
      sha256: r.sha256,
      sheet: r.sheet,
      title: r.title,
      spec: r.spec,
      protocolId: r.protocol_id,
      protocolVersionId: r.protocol_version_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );
export const ChartRows = z.array(ChartRow);

export const ChartWire = z.object({
  id: ChartId,
  sha256: Sha256,
  sheet: z.string(),
  title: z.string(),
  spec: ChartSpec,
  protocolId: ProtocolId.nullable(),
  protocolVersionId: ProtocolVersionId.nullable(),
  createdBy: UserId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<SavedChart>;
export const ChartsWire = z.array(ChartWire);

export type ChartSaveOutcome = { kind: "saved"; chart: SavedChart } | { kind: "stale" };
export const ChartSaveOutcomeWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), chart: ChartWire }),
  z.object({ kind: z.literal("stale") }),
]) satisfies z.ZodType<ChartSaveOutcome>;

export function chartHref(id: ChartId): string {
  return `/charts/${id}`;
}

export function newChartHref(file: LocationId, protocolId?: ProtocolId): string {
  const params = new URLSearchParams({ file });
  if (protocolId !== undefined) params.set("protocol", protocolId);
  return `/charts/new?${params}`;
}

// A file's name without its extension, as a new chart's first title.
export function titleFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).slice(0, TITLE_MAX);
}
