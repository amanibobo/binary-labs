import {
  checkSpec,
  isHeatmap,
  isXY,
  MAX_BARS,
  MAX_SERIES,
  nextStyle,
  specProblem,
  startingHeatmap,
  startingMeasure,
  startingXY,
  withType,
  type ChartSpec,
  type HeatmapSpec,
  type Series,
  type XYSpec,
  type XYType,
} from "./charts";
import { describeSummary, KINDS, kindOf, kindProblem, startKind, summarySuggestions, summaryWarnings, type ChartData, type ChartKind, type KindSuggestion } from "./summary-guide";
import { formatValue } from "./chart-geometry";
import {
  axisColumns,
  findColumn,
  formatDate,
  isMeanColumn,
  isSpreadColumn,
  numberColumns,
  repeatCount,
  spreadFor,
  type DataColumn,
  type DataTable,
  type NumberColumn,
} from "./data-tables";
import { plateCells, plateLayout } from "./plates";
import { readLabel } from "./plate-geometry";

// The builder's guide for someone making their first chart (decisions.md, "charts for a
// first-year student"): which kind of chart to suggest and why, how each kind starts from a
// table, and what a chart shows, in one sentence, with what's off in plain words. Pure, so the
// builder, its tests and the fixtures all read the same answers.

// Charts of a sheet's columns as they are, and the plate heatmap.
export type ChartType = XYType | "heatmap";

// The first question, "What do you want to show?", one answer per kind of chart.
export const CHOICES = [
  { type: "line", question: "How something changes", kind: "Line chart", hint: "Over time, or along a run" },
  { type: "bar", question: "Compare samples or groups", kind: "Bar chart", hint: "Side by side" },
  { type: "scatter", question: "How two measurements relate", kind: "Scatter chart", hint: "Like a standard curve" },
  { type: "heatmap", question: "A whole plate at a glance", kind: "Plate heatmap", hint: "Every well, colored by its value" },
] as const satisfies readonly { type: ChartType; question: string; kind: string; hint: string }[];

export type Choice = (typeof CHOICES)[number];

// The kinds of chart a table offers: a plate map only when it's laid out as a plate.
export function choicesFor(table: DataTable): Choice[] {
  return CHOICES.filter((c) => c.type !== "heatmap" || plateLayout(table) !== null);
}

export type Recommendation = { type: ChartType; reason: string };

const TIME_UNIT = /^(s|secs?|seconds?|min|mins|minutes?|h|hrs?|hours?|d|days?|wk|weeks?)$/i;
const TIME_NAME = /time|elapsed|\bday|\bhour|\bminute|\bsecond|\bcycle|\bweek/i;

function isTimeLike(column: DataColumn): boolean {
  if (column.kind === "date") return true;
  return column.kind === "number" && ((column.unit !== null && TIME_UNIT.test(column.unit.trim())) || TIME_NAME.test(column.name));
}

function goesUp(column: DataColumn): boolean {
  if (column.kind === "text") return false;
  let last = -Infinity;
  for (const v of column.values) {
    if (v === null) continue;
    if (v < last) return false;
    last = v;
  }
  return true;
}

// Past this many rows of numbers going up, the rows are a trace and a line reads them.
const TRACE_ROWS = 20;

// "a", "a and b", "a, b and c", "a, b and 4 more".
export function listPhrase(items: readonly string[], shown = 3): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length <= shown) return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  return `${items.slice(0, shown).join(", ")} and ${items.length - shown} more`;
}

function filled(column: DataColumn): number {
  return column.values.filter((v) => v !== null).length;
}

// The kind of chart to suggest for a table, with why in one short line. Null when the table
// has nothing to draw.
export function recommend(table: DataTable): Recommendation | null {
  const layout = plateLayout(table);
  if (layout !== null && layout.kind !== "read") return { type: "heatmap", reason: `This sheet is laid out like a ${layout.size}-well plate.` };
  if (layout?.kind === "read") {
    return { type: "line", reason: `Each well was read ${table.rows} times, so lines show how the wells change. It starts with the wells that ended lowest, in the middle and highest.` };
  }
  const start = startingXY(table);
  const x = start === null ? undefined : findColumn(table, start.x.column);
  if (start === null || x === undefined) return null;
  if (x.kind === "text") {
    const names = x.values.filter((v): v is string => v !== null);
    return { type: "bar", reason: `The rows are ${listPhrase(names)}, so bars put them side by side.` };
  }
  if (x.kind === "date") return { type: "line", reason: `${x.name} holds dates, so a line shows how things change over time.` };
  if (isTimeLike(x)) {
    return { type: "line", reason: `${x.name} counts up${x.unit ? ` in ${x.unit}` : ""}, so a line shows how things change over time.` };
  }
  if (goesUp(x) && filled(x) > TRACE_ROWS) return { type: "line", reason: `There are ${filled(x).toLocaleString("en-US")} readings along ${x.name}, so a line follows them.` };
  return { type: "scatter", reason: `Each of the ${filled(x)} rows pairs a ${x.name} value with a reading, as in a standard curve.` };
}

// An x/y chart built from its columns: names and units from the table, a style each, and each
// measured column's spreads as error bars when the table has them.
function xySpec(table: DataTable, type: XYType, x: DataColumn, measured: readonly NumberColumn[]): XYSpec {
  const series: Series[] = [];
  for (const m of measured.slice(0, MAX_SERIES[type])) {
    series.push({ column: m.id, name: m.name, ...nextStyle(series, type), error: spreadFor(table, m)?.id ?? null, x: null });
  }
  const only = measured.length === 1 ? measured[0] : null;
  const units = new Set(measured.map((m) => m.unit ?? ""));
  return {
    version: 1,
    type,
    x: { column: x.id, title: x.name, unit: x.kind === "number" ? (x.unit ?? "") : "", scale: "linear", min: null, max: null },
    y: { title: only?.name ?? "", unit: units.size === 1 ? [...units][0] : "", scale: "linear", min: null, max: null },
    series,
    legend: "top",
  };
}

function isFlat(column: NumberColumn): boolean {
  const values = column.values.filter((v): v is number => v !== null);
  if (values.length === 0) return true;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return hi - lo <= 0.01 * Math.max(Math.abs(lo), Math.abs(hi));
}

function lastValue(column: NumberColumn): number {
  for (let r = column.values.length - 1; r >= 0; r--) {
    const v = column.values[r];
    if (v !== null) return v;
  }
  return 0;
}

// The wells a kinetic read's line chart starts with: the ones that ended lowest, in the middle
// and highest, in plate order, so the first picture shows the plate's range rather than three
// neighbors that are likely repeats of each other.
export function spreadWells(wells: readonly NumberColumn[]): NumberColumn[] {
  if (wells.length <= 3) return [...wells];
  const byEnd = [...wells].sort((a, b) => lastValue(a) - lastValue(b));
  const picked = new Set([byEnd[0], byEnd[Math.floor((byEnd.length - 1) / 2)], byEnd[byEnd.length - 1]]);
  return wells.filter((w) => picked.has(w));
}

// How a chart of this kind starts from a table, ready to look at: the columns a student would
// most likely pick, already picked. Null when the table can't make that kind of chart.
export function startFor(table: DataTable, type: ChartType): ChartSpec | null {
  if (type === "heatmap") return startingHeatmap(table);
  const layout = plateLayout(table);
  if (layout?.kind === "read" && type !== "bar") {
    const x = layout.time ?? axisColumns(table)[0];
    const wells = layout.wells.map((w) => w.column).filter((c) => !isFlat(c));
    const picked = spreadWells(wells);
    if (x !== undefined && picked.length > 0) return xySpec(table, type, x, type === "scatter" ? picked.slice(-1) : picked);
  }
  const base = startingXY(table);
  const baseX = base === null ? undefined : findColumn(table, base.x.column);
  // Names that label most rows, not a fraction list beside a long trace.
  const names = table.columns.find((c) => c.kind === "text" && filled(c) <= MAX_BARS && filled(c) * 10 >= table.rows * 9);
  const x = type === "bar" ? (names ?? baseX) : baseX?.kind === "text" || baseX === undefined ? axisColumns(table)[0] : baseX;
  if (x === undefined) return null;
  const measured = startingMeasure(table, x);
  if (measured === null) return null;
  return xySpec(table, type, x, [measured]);
}

// The chart a new chart of a lone sheet opens on: the suggested kind, started.
export function startingChart(table: DataTable): ChartSpec | null {
  return startChart({ table, tables: [table], layout: null });
}

// ---------------------------------------------------------------------------------------------
// Kinds of chart (lib/summary-guide.ts): a kind is what a student picks; it starts as a chart
// of repeats when the sheet or the plate's layout has them, and as a chart of the sheet's own
// columns when it doesn't.

const RAW: Record<ChartKind, ChartType | null> = { line: "line", bar: "bar", scatter: "scatter", heatmap: "heatmap", dose: null, box: null, histogram: null };

// A scatter of a few rows reads best as a curve with a fitted line; a long trace as dots.
const CURVE_ROWS = 60;

// A chart of this kind of the data, or null when it can't be made.
export function startChart(data: ChartData, kind?: ChartKind): ChartSpec | null {
  const pick = kind ?? suggestionsFor(data)[0]?.kind;
  if (pick === undefined) return null;
  const summary = pick === "heatmap" ? null : startKind(data, pick);
  if (summary !== null && !(summary.type === "curve" && summary.source.kind === "rows" && summary.source.series[0]?.values.length === 1 && data.table.rows > CURVE_ROWS)) return summary;
  const raw = RAW[pick];
  return raw === null ? null : startFor(data.table, raw);
}

// The kinds to offer, best first, each with why in a line: what the repeats or the plate's
// layout suggest, then what the sheet's own columns do.
export function suggestionsFor(data: ChartData): KindSuggestion[] {
  const out: KindSuggestion[] = summarySuggestions(data).filter((s) => !(s.kind === "scatter" && data.table.rows > CURVE_ROWS && data.layout === null));
  const raw = recommend(data.table);
  const plate = plateLayout(data.table);
  if (raw !== null && !out.some((s) => s.kind === raw.type)) {
    const reason = raw.type === "heatmap" && plate !== null && plate.kind !== "read" && data.layout === null ? `${raw.reason} Mark its blanks, standards and samples to compare them or fit a curve.` : raw.reason;
    if (data.layout !== null || out.length === 0) out.push({ kind: raw.type, reason });
    else out.splice(Math.min(out.length, 1), 0, { kind: raw.type, reason });
  }
  return out.filter((s) => startChart(data, s.kind) !== null);
}

// Why this data can't make a kind, in a line, or null when it can.
export function kindChoiceProblem(data: ChartData, kind: ChartKind): string | null {
  if (startChart(data, kind) !== null) return null;
  const raw = RAW[kind];
  return raw === null ? kindProblem(data, kind) : (choiceProblem(data.table, raw) ?? kindProblem(data, kind));
}

export function kindsFor(data: ChartData): ChartKind[] {
  return KINDS.filter((k) => k !== "heatmap" || plateLayout(data.table) !== null);
}

// The chart a switch to another kind lands on. Between the sheet's own kinds it keeps the same
// columns; to and from a chart of repeats it starts that kind afresh, keeping the spread, the
// blank and the axis titles a student already set.
export function switchKind(spec: ChartSpec, kind: ChartKind, data: ChartData, other: ChartSpec | null): ChartSpec | null {
  if (kindOf(spec) === kind) return spec;
  if (other !== null && kindOf(other) === kind) return other;
  const next = startChart(data, kind);
  if (next === null) return null;
  const raw = RAW[kind];
  if (raw !== null && (isXY(next) || isHeatmap(next)) && (isXY(spec) || isHeatmap(spec))) return switched(spec, raw, data.table, other);
  if (next.type === "groups" && spec.type === "groups") return { ...spec, mark: next.mark, points: spec.points || next.mark === "box", y: next.mark === "bar" ? { ...spec.y, scale: "linear" } : spec.y };
  if ("spread" in next && "spread" in spec) return { ...next, spread: spec.spread, blank: spec.blank && next.blank };
  return next;
}

export function kindSwitchProblem(spec: ChartSpec, kind: ChartKind, data: ChartData, other: ChartSpec | null): string | null {
  if (kindOf(spec) === kind) return null;
  const next = switchKind(spec, kind, data, other);
  if (next === null) return kindChoiceProblem(data, kind);
  if (isXY(spec) && next.type === "scatter" && spec.series.length > MAX_SERIES.scatter) {
    return `A scatter chart shows up to ${MAX_SERIES.scatter} columns, and this one has ${spec.series.length}.`;
  }
  return barProblem(next, data.table) ?? specProblem(next) ?? checkSpec(next, data.table, data.tables);
}

function barProblem(spec: ChartSpec, table: DataTable): string | null {
  if (spec.type !== "bar") return null;
  const x = findColumn(table, spec.x.column);
  const bars = x === undefined ? 0 : filled(x);
  return bars > MAX_BARS ? `${bars.toLocaleString("en-US")} rows in the sheet are too many for bars. A line reads better.` : null;
}

// Why a table can't make this kind of chart, or null when it can.
export function choiceProblem(table: DataTable, type: ChartType): string | null {
  if (type === "heatmap") return plateLayout(table) === null ? "This sheet isn't laid out as a plate." : null;
  const numbers = numberColumns(table).length;
  if (numbers === 0) return "This sheet has no numbers to draw.";
  const spec = startFor(table, type);
  if (spec === null) {
    if (type !== "bar") return numbers === 1 ? "There's one column of numbers, and nothing to set it against." : "There's no column of numbers or dates to put along the bottom.";
    return table.rows > MAX_BARS ? `${table.rows.toLocaleString("en-US")} rows in the sheet are too many for bars.` : "There's nothing here to put side by side.";
  }
  return barProblem(spec, table) ?? specProblem(spec) ?? checkSpec(spec, table);
}

// The chart a switch to another kind lands on: the chart of that kind it came from, when
// there is one (a plate and back), the same columns as the other kind of x/y chart, or else
// that kind as a new chart of this table starts.
export function switched(spec: ChartSpec, type: ChartType, table: DataTable, other: ChartSpec | null): ChartSpec | null {
  if (spec.type === type) return spec;
  const crossing = (spec.type === "heatmap") !== (type === "heatmap");
  const kept = other !== null && (other.type === "heatmap") === (type === "heatmap");
  return crossing && !kept ? startFor(table, type) : withType(spec, type, table, other);
}

// Why a chart can't switch to another kind as it stands, or null when it can.
export function switchProblem(spec: ChartSpec, type: ChartType, table: DataTable, other: ChartSpec | null): string | null {
  if (spec.type === type) return null;
  const next = switched(spec, type, table, other);
  if (next === null || next.type !== type) return choiceProblem(table, type);
  if (next.type === "scatter" && isXY(spec) && spec.series.length > MAX_SERIES.scatter) {
    return `A scatter chart shows up to ${MAX_SERIES.scatter} columns, and this one has ${spec.series.length}.`;
  }
  return barProblem(next, table) ?? specProblem(next) ?? checkSpec(next, table);
}

// A few of a column's real values, as a column card shows them: "0, 125, 250, 500, …".
export function columnSample(column: DataColumn, count = 4): string {
  const values: string[] = [];
  let more = false;
  for (let r = 0; r < column.values.length; r++) {
    const v = column.values[r];
    if (v === null) continue;
    if (values.length === count) {
      more = true;
      break;
    }
    values.push(typeof v === "string" ? (v.length > 18 ? `${v.slice(0, 17)}…` : v) : column.kind === "date" ? formatDate(v, column.time) : formatValue(v));
  }
  return values.length === 0 ? "Blank" : `${values.join(", ")}${more ? ", …" : ""}`;
}

// What a column holds, in words: "Numbers", "Dates", or "Text, not numbers".
export function columnKind(column: DataColumn): string {
  return column.kind === "number" ? "Numbers" : column.kind === "date" ? "Dates" : "Text, not numbers";
}

// An axis label typed on the chart, "Absorbance (AU)", back to its title and unit.
export function splitAxisText(text: string): { title: string; unit: string } {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(text.trim());
  return m === null ? { title: text.trim(), unit: "" } : { title: m[1].trim(), unit: m[2].trim() };
}

export function axisText(title: string, unit: string): string {
  const t = title.trim();
  const u = unit.trim();
  if (t === "") return u;
  return u === "" ? t : `${t} (${u})`;
}

type Drawn = { series: Series; column: NumberColumn };

function drawnSeries(spec: XYSpec, table: DataTable): Drawn[] {
  return spec.series.flatMap((s) => {
    const column = findColumn(table, s.column);
    return column?.kind === "number" ? [{ series: s, column }] : [];
  });
}

// The table rows the chart draws along its shared x: an x and at least one value.
function drawnRows(spec: XYSpec, table: DataTable, drawn: readonly Drawn[]): number[] {
  const x = findColumn(table, spec.x.column);
  if (x === undefined) return [];
  const rows: number[] = [];
  for (let r = 0; r < table.rows; r++) {
    if (x.values[r] === null || x.values[r] === undefined) continue;
    if (drawn.some((d) => d.series.x === null && d.column.values[r] !== null && d.column.values[r] !== undefined)) rows.push(r);
  }
  return rows;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function bound(v: number, column: DataColumn | undefined): string {
  return column?.kind === "date" ? formatDate(v, column.time) : formatValue(v);
}

// What a chart shows, in one or two sentences a student can check against what they meant:
// "Mean (AU) for 8 BSA values from 0 to 2,000 µg/mL, each the mean of 3 repeats in the sheet, with bars showing
// how much the repeats vary (± SD)."
export function describeChart(spec: ChartSpec, table: DataTable, tables: readonly DataTable[] = [table]): string {
  if (isHeatmap(spec)) return describePlate(spec, table);
  if (isXY(spec)) return describeXY(spec, table);
  return describeSummary(spec, { table, tables, layout: null });
}

function describeXY(spec: XYSpec, table: DataTable): string {
  const x = findColumn(table, spec.x.column);
  const drawn = drawnSeries(spec, table);
  if (x === undefined || drawn.length === 0) return "";
  const rows = drawnRows(spec, table, drawn);
  const xName = spec.x.title.trim() || x.name;
  const xUnit = x.kind === "number" && spec.x.unit.trim() !== "" ? ` ${spec.x.unit.trim()}` : "";
  const yAxis = axisText(spec.y.title, spec.y.unit);
  const names = drawn.map((d) => d.series.name);
  const measured = drawn.length === 1 ? yAxis || names[0] : yAxis === "" ? listPhrase(names) : `${yAxis} of ${listPhrase(names)}`;

  const xs = rows.flatMap((r) => {
    const v = x.values[r];
    return typeof v === "number" ? [v] : [];
  });
  const lo = xs.length === 0 ? null : Math.min(...xs);
  const hi = xs.length === 0 ? null : Math.max(...xs);
  const span = lo === null || hi === null ? "" : lo === hi ? ` at ${bound(lo, x)}${xUnit}` : ` from ${bound(lo, x)} to ${bound(hi, x)}${xUnit}`;
  const points = `${plural(rows.length, "point")}${drawn.length > 1 ? " each" : ""}`;

  let first: string;
  switch (spec.type) {
    case "line":
      first = lo !== null && lo !== hi ? `${measured} as ${xName} goes${span}, ${points}` : `${measured} against ${xName}${span}, ${points}`;
      break;
    case "scatter":
      first = `${measured} for ${plural(rows.length, `${xName} value`)}${span}`;
      break;
    case "bar": {
      const labels = rows.map((r) => {
        const v = x.values[r];
        return typeof v === "string" ? v : typeof v === "number" ? bound(v, x) : "";
      });
      first = `${measured} for each ${xName}: ${listPhrase(labels)}`;
      break;
    }
    default: {
      const _exhaustive: never = spec.type;
      return _exhaustive;
    }
  }

  const clauses: string[] = [];
  const repeats = repeatCount(table);
  if (drawn.length === 1 && isMeanColumn(drawn[0].column) && repeats > 0) clauses.push(`each the mean of ${repeats} repeats in the sheet`);
  const withError = drawn.flatMap((d) => {
    const e = d.series.error === null ? undefined : findColumn(table, d.series.error);
    return e === undefined ? [] : [{ name: d.series.name, error: e }];
  });
  if (withError.length > 0) {
    const errorNames = [...new Set(withError.map((w) => w.error.name))];
    const which = withError.length < drawn.length ? ` on ${listPhrase(withError.map((w) => w.name))}` : "";
    clauses.push(
      withError.every((w) => isSpreadColumn(w.error))
        ? `with bars${which} showing how much the repeats vary${errorNames.length === 1 ? ` (± ${errorNames[0]})` : ""}`
        : `with error bars${which} of ± ${listPhrase(errorNames)}`,
    );
  }

  const more: string[] = [];
  if (spec.x.scale === "log") more.push("The bottom axis is a log scale, so each step along is ten times the one before.");
  if (spec.y.scale === "log") more.push("The side axis is a log scale, so each step up is ten times the one before.");
  const { min: xMin, max: xMax } = spec.x;
  if (xMin !== null || xMax !== null) {
    const range = xMin !== null && xMax !== null ? `from ${bound(xMin, x)} to ${bound(xMax, x)}` : xMin !== null ? `from ${bound(xMin, x)} up` : `up to ${bound(xMax ?? 0, x)}`;
    more.push(`Only ${xName} ${range}${xUnit} is shown.`);
  }
  const { min: yMin, max: yMax } = spec.y;
  if (yMin !== null || yMax !== null) {
    const range = yMin !== null && yMax !== null ? `from ${formatValue(yMin)} to ${formatValue(yMax)}` : yMin !== null ? `from ${formatValue(yMin)} up` : `up to ${formatValue(yMax ?? 0)}`;
    more.push(`The side axis runs ${range}.`);
  }
  for (const d of drawn) {
    const own = d.series.x === null ? undefined : findColumn(table, d.series.x);
    if (own !== undefined) more.push(`${d.series.name} is drawn against its own bottom column, ${own.name}${own.unit ? ` (${own.unit})` : ""}, as the instrument recorded it.`);
  }

  return [`${[first, ...clauses].join(", ")}.`, ...more].join(" ");
}

function describePlate(spec: HeatmapSpec, table: DataTable): string {
  const layout = plateLayout(table);
  const cells = layout === null ? [] : plateCells(table, layout, spec.plate.source);
  const values = cells.flatMap((c) => (c.value === null ? [] : [c.value]));
  const what = axisText(spec.value.title, spec.value.unit) || "The value";
  const size = spec.plate.size;
  const span = values.length === 0 ? "" : `, from ${formatValue(Math.min(...values))} to ${formatValue(Math.max(...values))}`;
  const wells = values.length < size ? ` ${values.length} of the ${size} wells have a number.` : "";
  const read = readLabel(spec, table);
  const at = read === null ? "" : ` This is ${read.charAt(0).toLowerCase()}${read.slice(1)}.`;
  const { min, max } = spec.value;
  const scale = min !== null || max !== null ? ` The colors run ${min !== null ? `from ${formatValue(min)} ` : ""}${max !== null ? `up to ${formatValue(max)}` : "up"}.` : "";
  return `${what} in each well of a ${size}-well plate${span}, as the scale under the plate shows.${wells}${at}${scale}`;
}

// What's off about a chart, each in one plain sentence; empty when nothing is.
export function chartWarnings(spec: ChartSpec, table: DataTable, tables: readonly DataTable[] = [table]): string[] {
  if (spec.type === "heatmap") {
    const source = spec.plate.source;
    const value = source.kind === "wells" ? findColumn(table, source.value) : undefined;
    return value === undefined ? [] : invalidCells([value]);
  }
  if (!isXY(spec)) return summaryWarnings(spec, { table, tables, layout: null });
  const out: string[] = [];
  const x = findColumn(table, spec.x.column);
  const drawn = drawnSeries(spec, table);
  const used = [x, ...drawn.map((d) => d.column), ...drawn.map((d) => (d.series.error === null ? undefined : findColumn(table, d.series.error)))];
  out.push(...invalidCells(used.filter((c): c is DataColumn => c !== undefined)));
  const units = [...new Set(drawn.map((d) => d.column.unit ?? "").filter((u) => u !== ""))];
  if (units.length > 1) {
    out.push(`${listPhrase(drawn.map((d) => d.series.name))} have different units (${listPhrase(units)}) but share one side axis. A chart for each may read better.`);
  }
  const rows = drawnRows(spec, table, drawn);
  if (spec.type === "bar" && x !== undefined && x.kind !== "text" && rows.length > 30) {
    out.push(`These ${rows.length} bars are crowded. A line may read better.`);
  }
  if (spec.type === "line" && x !== undefined && !goesUp(x)) {
    out.push(`${spec.x.title.trim() || x.name} doesn't go up row by row, so the line doubles back. A scatter chart may read better.`);
  }
  return out;
}

function invalidCells(columns: readonly DataColumn[]): string[] {
  const seen = new Set<string>();
  return columns.flatMap((c) => {
    if (c.invalid === 0 || seen.has(c.id)) return [];
    seen.add(c.id);
    const n = c.invalid;
    const what = c.kind === "date" ? (n === 1 ? "isn't a date" : "aren't dates") : n === 1 ? "isn't a number" : "aren't numbers";
    return [`${c.name} has ${plural(n, "cell")} that ${what}, so ${n === 1 ? "it's" : "they're"} left out.`];
  });
}

// The columns that can go along the bottom of this kind of chart, and those that can be
// measured on it, each with why not when it can't.
export function bottomChoices(table: DataTable, type: XYType): { column: DataColumn; problem: string | null }[] {
  return table.columns.map((column) => ({
    column,
    problem: type === "bar" || column.kind !== "text" ? null : "Text, not numbers. Bar charts can use it.",
  }));
}

export function measureChoices(table: DataTable): { column: DataColumn; problem: string | null }[] {
  return table.columns.map((column) => ({
    column,
    problem: column.kind === "number" ? null : column.kind === "date" ? "Dates, not measurements" : "Text, not numbers",
  }));
}
