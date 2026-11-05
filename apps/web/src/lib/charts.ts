import { z } from "zod";
import { columnLabel, findColumn, numberColumns, type DataColumn, type DataTable, type NumberColumn } from "./data-tables";
import { ChartId, ColumnId, ProtocolId, Sha256, UserId, type LocationId } from "./ids";

// decisions.md, "data sheet to chart". A chart names a file by content, one of its tables, and
// this spec; db/migrations/0014_charts.sql checks the same structure in chart_spec_ok.

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

export const CHART_TYPES = ["line", "scatter", "bar"] as const;
export const ChartType = z.enum(CHART_TYPES);
export type ChartType = z.infer<typeof ChartType>;
export const CHART_TYPE_NAMES = { line: "Line", scatter: "Scatter", bar: "Bar" } satisfies Record<ChartType, string>;

export const LEGEND_POSITIONS = ["top", "right", "bottom"] as const;
export const LegendPosition = z.enum(LEGEND_POSITIONS);
export type LegendPosition = z.infer<typeof LegendPosition>;

// Scatter puts any two series side by side, and only the first three hues stay apart that way.
export const MAX_SERIES = { line: 6, scatter: 3, bar: 6 } satisfies Record<ChartType, number>;
// Past this a bar chart's labels can't be read; a line chart reads the same data.
export const MAX_BARS = 60;

const AxisText = z.string().trim().max(80);
const Unit = z.string().trim().max(24);
const Bound = z.number().finite().nullable();

export const Series = z.object({
  column: ColumnId,
  name: z.string().trim().min(1, "Name every series.").max(80),
  color: SeriesColor,
  // A column of ± values drawn as error bars.
  error: ColumnId.nullable(),
});
export type Series = z.infer<typeof Series>;

const SpecShape = z.object({
  version: z.literal(1),
  type: ChartType,
  x: z.object({ column: ColumnId, title: AxisText, unit: Unit, min: Bound, max: Bound }),
  y: z.object({ title: AxisText, unit: Unit, scale: z.enum(["linear", "log"]), min: Bound, max: Bound }),
  series: z.array(Series).min(1, "Pick a column to plot.").max(6, "A chart takes up to six series."),
  legend: LegendPosition,
});
export type ChartSpec = z.infer<typeof SpecShape>;

export const ChartSpec = SpecShape.superRefine((spec, ctx) => {
  const problem = specProblem(spec);
  if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
});

// What the spec alone rules out; checkSpec below also needs the table.
export function specProblem(spec: ChartSpec): string | null {
  if (spec.series.length > MAX_SERIES[spec.type]) {
    return "A scatter chart takes up to three series. A line chart takes six.";
  }
  if (spec.type === "bar" && spec.y.scale === "log") return "Bars start at zero, so they can't use a log scale.";
  if (spec.y.scale === "log" && spec.y.min !== null && spec.y.min <= 0) return "A log scale starts above zero.";
  for (const axis of [spec.x, spec.y]) {
    if (axis.min !== null && axis.max !== null && axis.min >= axis.max) return "Each range has to start below where it ends.";
  }
  const columns = spec.series.map((s) => s.column);
  if (new Set(columns).size !== columns.length) return "Each column can be plotted once.";
  if (columns.includes(spec.x.column)) return "A column can't be plotted against itself.";
  return null;
}

// The first thing wrong with a spec for this table, in words, or null when it can be drawn.
export function checkSpec(spec: ChartSpec, table: DataTable): string | null {
  const x = findColumn(table, spec.x.column);
  if (x === undefined) return `Column ${spec.x.column} isn't in ${table.name}.`;
  if (spec.type !== "bar" && x.kind !== "number") {
    return `${columnLabel(x)} holds text. Pick a bar chart, or a column of numbers for x.`;
  }
  for (const s of spec.series) {
    const column = findColumn(table, s.column);
    if (column === undefined) return `Column ${s.column} isn't in ${table.name}.`;
    if (column.kind !== "number") return `${columnLabel(column)} holds text, so it can't be plotted.`;
    if (s.error !== null) {
      const error = findColumn(table, s.error);
      if (error === undefined) return `Column ${s.error} isn't in ${table.name}.`;
      if (error.kind !== "number") return `${columnLabel(error)} holds text, so it can't be error bars.`;
    }
  }
  if (spec.type === "bar") {
    const bars = x.values.filter((v) => v !== null).length;
    if (bars > MAX_BARS) return `A bar chart takes up to ${MAX_BARS} bars, and this table has ${bars} rows. Try a line chart.`;
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

export function nextColor(series: readonly Series[]): SeriesColor {
  const used = new Set(series.map((s) => s.color));
  return SERIES_COLORS.find((c) => !used.has(c)) ?? SERIES_COLORS[series.length % SERIES_COLORS.length];
}

function isIncreasing(column: NumberColumn): boolean {
  let last = -Infinity;
  for (const v of column.values) {
    if (v === null) continue;
    if (v < last) return false;
    last = v;
  }
  return true;
}

// What a new chart of a table starts as: the first numbers column along x and the next one
// plotted, as a line when x only goes up. A table of names and numbers starts as bars. Null
// when there's nothing to plot.
export function startingSpec(table: DataTable): ChartSpec | null {
  const start = startingColumns(table);
  if (start === null) return null;
  const { x, y } = start;
  const type: ChartType = x.kind === "text" ? "bar" : isIncreasing(x) ? "line" : "scatter";
  return {
    version: 1,
    type,
    x: { column: x.id, title: x.name, unit: x.unit ?? "", min: null, max: null },
    y: { title: y.name, unit: y.unit ?? "", scale: "linear", min: null, max: null },
    series: [{ column: y.id, name: y.name, color: SERIES_COLORS[0], error: null }],
    legend: "top",
  };
}

function startingColumns(table: DataTable): { x: DataColumn; y: NumberColumn } | null {
  const [first, second] = numberColumns(table);
  if (first === undefined) return null;
  if (second !== undefined) return { x: first, y: second };
  const names = table.columns.find((c) => c.kind === "text");
  if (names !== undefined && names.values.filter((v) => v !== null).length <= MAX_BARS) return { x: names, y: first };
  return null;
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
  createdBy: UserId | null;
  createdAt: string;
  updatedAt: string;
};

export const CHART_COLUMNS = "id, sha256, sheet, title, spec, protocol_id, created_by, created_at, updated_at";

export const ChartRow = z
  .object({
    id: ChartId,
    sha256: Sha256,
    sheet: z.string(),
    title: z.string(),
    spec: ChartSpec,
    protocol_id: ProtocolId.nullable(),
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
