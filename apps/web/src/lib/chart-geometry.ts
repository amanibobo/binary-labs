import { MAX_SERIES, type Series, type SeriesColor, type Stroke, type XYSpec } from "./charts";
import { findColumn, formatDate, type DataColumn, type DataTable } from "./data-tables";
import { formatValue } from "./numbers";

export { formatValue };

// Where every mark of a line, scatter or bar chart goes, from its spec, its table and a size.
// Pure, so the live chart, the exported SVG and the tests all draw from the same numbers. Text
// widths are estimated, not measured, so this runs on the server and in tests too. Plates are
// drawn by plate-geometry.ts.

export type Tick = { pos: number; label: string };
export type Point = { row: number; x: number; y: number; px: number; py: number };
export type Whisker = { px: number; top: number; bottom: number };
export type Bar = { row: number; path: string; x: number; width: number; top: number; bottom: number };
export type PlotSeries = {
  column: string;
  name: string;
  color: DrawColor;
  stroke: Stroke;
  // Read along its own x column, so the hover layer finds its nearest point, not its row.
  ownX: boolean;
  points: Point[];
  // Line charts: the line, broken where a value is blank.
  path: string | null;
  bars: Bar[];
  whiskers: Whisker[];
  markers: boolean;
  label: { x: number; y: number } | null;
};
export type AxisTitle = { text: string; x: number; y: number; placeholder: boolean };
export type LegendItem = { name: string; color: DrawColor; stroke: Stroke; x: number; y: number };
// A series color, or the gray of a failed run.
export type DrawColor = SeriesColor | "muted";
// A place the hover layer snaps to along x. row is the table row when every series that shares
// the chart's x has its value there; series with their own x find their nearest point.
export type Stop = { row: number | null; px: number; label: string };
export type Plot = {
  width: number;
  height: number;
  area: { left: number; top: number; width: number; height: number };
  title: { text: string; x: number; y: number } | null;
  xTicks: Tick[];
  yTicks: Tick[];
  // An axis title; a placeholder is the "Add a title" an editable chart shows where none is set.
  xTitle: AxisTitle | null;
  yTitle: AxisTitle | null;
  // The y position of the zero line when it's in view; bars stand on it.
  baseline: number | null;
  series: PlotSeries[];
  legend: LegendItem[];
  legendMark: "line" | "dot" | "bar";
  // Where the hover layer snaps along x, left to right.
  stops: Stop[];
  notes: string[];
};

export const TICK_FONT = 12;
export const LABEL_FONT = 13;
export const TITLE_FONT = 17;
export const PLACEHOLDER = "Click to name this axis";
const MAX_POINTS = 5_000;
const MARKERS_UP_TO = 40;
// A marker's height on screen: a 4 px radius and the outer half of its 2 px ring.
const MARKER_SPAN = 10;
// Past this many points the hover layer reads the thinned line instead of every row.
const HOVER_POINTS = 20_000;
const BAR_MAX = 24;
const GAP = 2;

export function textWidth(text: string, size: number): number {
  return text.length * size * 0.56;
}

const sig = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function tickFormat(step: number, span: number): (v: number) => string {
  if (span >= 10_000) return (v) => compact.format(v);
  if (step < 1e-4) return (v) => (v === 0 ? "0" : v.toExponential(1));
  const digits = Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9)));
  const f = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (v) => f.format(Math.abs(v) < step / 1e6 ? 0 : v);
}

// d3's tick step: 1, 2 or 5 times a power of ten, near span / count.
export function tickStep(lo: number, hi: number, count: number): number {
  const raw = Math.abs(hi - lo) / Math.max(1, count);
  if (raw === 0 || !Number.isFinite(raw)) return 1;
  let step = 10 ** Math.floor(Math.log10(raw));
  const ratio = raw / step;
  if (ratio >= Math.sqrt(50)) step *= 10;
  else if (ratio >= Math.sqrt(10)) step *= 5;
  else if (ratio >= Math.sqrt(2)) step *= 2;
  return step;
}

export function niceDomain(lo: number, hi: number, count: number): [number, number] {
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    return niceDomain(lo - pad, hi + pad, count);
  }
  const step = tickStep(lo, hi, count);
  return [Number((Math.floor(lo / step) * step).toPrecision(12)), Number((Math.ceil(hi / step) * step).toPrecision(12))];
}

export function linearTicks(lo: number, hi: number, count: number): number[] {
  const step = tickStep(lo, hi, count);
  const out: number[] = [];
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  for (let i = first; i <= last; i++) out.push(Number((i * step).toPrecision(12)));
  return out;
}

export function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  const decades = Math.log10(hi) - Math.log10(lo);
  const steps = decades <= 2 ? [1, 2, 5] : [1];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of steps) {
      const v = Number((m * 10 ** e).toPrecision(12));
      if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) out.push(v);
    }
  }
  return out;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Steps a time axis may tick at, from a second to a week; past that, months and years.
const TIME_STEPS = [1, 2, 5, 10, 15, 30].map((s) => s * SECOND).concat(
  [1, 2, 5, 10, 15, 30].map((m) => m * MINUTE),
  [1, 2, 3, 6, 12].map((h) => h * HOUR),
  [1, 2, 7].map((d) => d * DAY),
);
const MONTH_STEPS = [1, 2, 3, 6];

const utc = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts });
const clockSeconds = utc({ hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const clock = utc({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const monthDay = utc({ month: "short", day: "numeric" });
const month = utc({ month: "short" });
const year = utc({ year: "numeric" });

export type TimeStep = { kind: "fixed"; ms: number } | { kind: "months"; months: number } | { kind: "years"; years: number };

export function timeStep(lo: number, hi: number, count: number): TimeStep {
  const target = (hi - lo) / Math.max(1, count);
  const fixed = TIME_STEPS.find((s) => s >= target);
  if (fixed !== undefined && (fixed < 7 * DAY || target <= 10 * DAY)) return { kind: "fixed", ms: fixed };
  const months = MONTH_STEPS.find((m) => m * 30 * DAY >= target);
  if (months !== undefined) return { kind: "months", months };
  const years = tickStep(0, target / (365 * DAY), 1);
  return { kind: "years", years: Math.max(1, Math.round(years)) };
}

// Ticks on a time axis, minutes to months, each labeled at the coarsest unit that changes:
// "06:00", then "Nov 4" at midnight; "Nov 3"; "Dec", then "2027" in January.
export function timeTicks(lo: number, hi: number, count: number): { values: number[]; label: (v: number) => string } {
  const step = timeStep(lo, hi, count);
  const values: number[] = [];
  switch (step.kind) {
    case "fixed": {
      for (let v = Math.ceil(lo / step.ms) * step.ms; v <= hi && values.length < 500; v += step.ms) values.push(v);
      const midnight = (v: number) => v % DAY === 0;
      if (step.ms < MINUTE) return { values, label: (v) => (midnight(v) ? monthDay.format(v) : clockSeconds.format(v)) };
      if (step.ms < DAY) return { values, label: (v) => (midnight(v) ? monthDay.format(v) : clock.format(v)) };
      return { values, label: (v) => monthDay.format(v) };
    }
    case "months": {
      const start = new Date(lo);
      let y = start.getUTCFullYear();
      let m = start.getUTCMonth();
      if (Date.UTC(y, m, 1) < lo) m += 1;
      m = Math.ceil(m / step.months) * step.months;
      for (let v = Date.UTC(y, m, 1); v <= hi && values.length < 500; v = Date.UTC(y, m, 1)) {
        values.push(v);
        m += step.months;
        if (m >= 12) {
          y += Math.floor(m / 12);
          m %= 12;
        }
      }
      return { values, label: (v) => (new Date(v).getUTCMonth() === 0 ? year.format(v) : month.format(v)) };
    }
    case "years": {
      const first = Math.ceil(new Date(lo).getUTCFullYear() / step.years) * step.years;
      for (let y = first; Date.UTC(y, 0, 1) <= hi && values.length < 500; y += step.years) {
        if (Date.UTC(y, 0, 1) >= lo) values.push(Date.UTC(y, 0, 1));
      }
      return { values, label: (v) => year.format(v) };
    }
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

export type Scale = { map: (v: number) => number; ticks: Tick[] };

export function linearScale(lo: number, hi: number, r0: number, r1: number, count: number): Scale {
  const map = (v: number) => r0 + ((v - lo) / (hi - lo)) * (r1 - r0);
  const values = linearTicks(lo, hi, count);
  const format = tickFormat(tickStep(lo, hi, count), Math.max(Math.abs(lo), Math.abs(hi)));
  return { map, ticks: values.map((v) => ({ pos: map(v), label: format(v) })) };
}

function timeScale(lo: number, hi: number, r0: number, r1: number, count: number): Scale {
  const map = (v: number) => r0 + ((v - lo) / (hi - lo)) * (r1 - r0);
  const { values, label } = timeTicks(lo, hi, count);
  return { map, ticks: values.map((v) => ({ pos: map(v), label: label(v) })) };
}

export function logScale(lo: number, hi: number, r0: number, r1: number): Scale {
  const [l0, l1] = [Math.log10(lo), Math.log10(hi)];
  const map = (v: number) => r0 + ((Math.log10(v) - l0) / (l1 - l0)) * (r1 - r0);
  return { map, ticks: logTicks(lo, hi).map((v) => ({ pos: map(v), label: v >= 10_000 ? compact.format(v) : sig.format(v) })) };
}

function axisText(title: string, unit: string): string {
  const t = title.trim();
  const u = unit.trim();
  if (t === "") return u;
  return u === "" ? t : `${t} (${u})`;
}

// A number column's value, or a date column's milliseconds: anything that has a place on an axis.
function numberAt(column: DataColumn | undefined, row: number): number | null {
  if (column === undefined || column.kind === "text") return null;
  return column.values[row] ?? null;
}

function categoryLabel(column: DataColumn, row: number): string | null {
  switch (column.kind) {
    case "text":
      return column.values[row] ?? null;
    case "number": {
      const v = column.values[row];
      return v === null || v === undefined ? null : formatValue(v);
    }
    case "date": {
      const v = column.values[row];
      return v === null || v === undefined ? null : formatDate(v, column.time);
    }
    default: {
      const _exhaustive: never = column;
      return _exhaustive;
    }
  }
}

// A position along x as the readout says it.
export function xLabel(column: DataColumn | undefined, v: number): string {
  return column?.kind === "date" ? formatDate(v, column.time) : formatValue(v);
}

const round = (v: number) => Math.round(v * 10) / 10;

export function plotChart(
  spec: XYSpec,
  table: DataTable,
  size: { width: number; height: number },
  options: { title?: string; placeholders?: boolean; muted?: ReadonlySet<string> } = {},
): Plot {
  const notes: string[] = [];
  // A failed run (lib/runs.ts) is drawn gray and dashed, whatever its own style.
  const drawStyle = (s: Series): { color: DrawColor; stroke: Stroke } => (options.muted?.has(s.column) ? { color: "muted", stroke: "dashed" } : { color: s.color, stroke: s.stroke });
  const isBar = spec.type === "bar";
  const xColumn = findColumn(table, spec.x.column);
  const seriesColumns = spec.series.slice(0, MAX_SERIES[spec.type]).map((s) => {
    const own = isBar || s.x === null ? undefined : findColumn(table, s.x);
    return { spec: s, column: findColumn(table, s.column), error: s.error === null ? undefined : findColumn(table, s.error), x: own ?? xColumn, ownX: own !== undefined };
  });
  const isLog = spec.y.scale === "log" && !isBar;

  // Rows that carry an x and a value, per series: a series with its own x has its own rows.
  const rowsOf = seriesColumns.map((s) => {
    const rows: number[] = [];
    for (let r = 0; r < table.rows; r++) {
      const hasX = s.x !== undefined && (isBar ? categoryLabel(s.x, r) !== null : numberAt(s.x, r) !== null);
      if (hasX && numberAt(s.column, r) !== null) rows.push(r);
    }
    return rows;
  });
  // The shared rows: an x and at least one value of a series that reads along it.
  const sharedRows: number[] = [];
  for (let r = 0; r < table.rows; r++) {
    const hasX = xColumn !== undefined && (isBar ? categoryLabel(xColumn, r) !== null : numberAt(xColumn, r) !== null);
    if (hasX && seriesColumns.some((s) => !s.ownX && numberAt(s.column, r) !== null)) sharedRows.push(r);
  }

  // The y extent, error bars included.
  let yLo = Infinity;
  let yHi = -Infinity;
  let dropped = 0;
  seriesColumns.forEach((s, si) => {
    for (const r of rowsOf[si]) {
      const y = numberAt(s.column, r);
      if (y === null) continue;
      if (isLog && y <= 0) {
        dropped++;
        continue;
      }
      const e = Math.abs(numberAt(s.error, r) ?? 0);
      const lo = isLog && y - e <= 0 ? y : y - e;
      yLo = Math.min(yLo, lo);
      yHi = Math.max(yHi, y + e);
    }
  });
  if (dropped > 0) notes.push(`${dropped} ${dropped === 1 ? "value" : "values"} at or below zero left off the log scale.`);
  const hasData = Number.isFinite(yLo);
  if (!hasData) {
    [yLo, yHi] = isLog ? [1, 10] : [0, 1];
    notes.push("Nothing to draw yet: these columns have no numbers in the same rows.");
  }
  if (isBar) {
    yLo = Math.min(0, yLo);
    yHi = Math.max(0, yHi);
  }

  // Layout, outside in: title, legend, axis titles, tick labels, then the plot area.
  const legendNames = seriesColumns.length >= 2 ? seriesColumns.map((s) => s.spec.name) : [];
  const legendItemWidth = (name: string) => 22 + textWidth(name, TICK_FONT) + 16;
  let top = 8;
  let bottom = 0;
  // Room for half of the last x tick label, which is centred on the plot's right edge.
  let right = 28;
  const title = options.title ? { text: options.title, x: 0, y: TITLE_FONT + 4 } : null;
  if (title) top += TITLE_FONT + 16;

  const legend: LegendItem[] = [];
  const legendRow = (y: number, start: number) => {
    let x = start;
    let line = y;
    for (const [i, name] of legendNames.entries()) {
      const w = legendItemWidth(name);
      if (x + w > size.width && x > start) {
        x = start;
        line += 20;
      }
      const { color, stroke } = drawStyle(seriesColumns[i].spec);
      legend.push({ name, color, stroke, x, y: line });
      x += w;
    }
    return line - y + 20;
  };
  let legendRight = 0;
  if (legendNames.length > 0 && spec.legend === "top") top += legendRow(top + 6, 0) + 8;
  if (legendNames.length > 0 && spec.legend === "right") {
    legendRight = Math.min(size.width * 0.35, Math.max(...legendNames.map(legendItemWidth)));
    right += legendRight;
  }

  const yTitleSet = axisText(spec.y.title, spec.y.unit);
  const xTitleSet = axisText(spec.x.title, xColumn?.kind === "date" ? "" : spec.x.unit);
  const yTitleText = yTitleSet || (options.placeholders ? PLACEHOLDER : "");
  const xTitleText = xTitleSet || (options.placeholders ? PLACEHOLDER : "");

  // The y domain, so the tick labels can be measured.
  const plotHeightGuess = Math.max(80, size.height - top - 60);
  let yDomain: [number, number];
  if (isLog) {
    const lo = spec.y.min ?? 10 ** Math.floor(Math.log10(yLo));
    const hi = spec.y.max ?? 10 ** Math.ceil(Math.log10(yHi === yLo ? yHi * 10 : yHi));
    yDomain = [lo, hi > lo ? hi : lo * 10];
  } else {
    const count = Math.max(2, Math.round(plotHeightGuess / 50));
    const nice = niceDomain(yLo, yHi, count);
    yDomain = [spec.y.min ?? nice[0], spec.y.max ?? nice[1]];
    if (yDomain[0] >= yDomain[1]) yDomain = nice;
  }
  const yCount = Math.max(2, Math.round(plotHeightGuess / 50));
  const yProbe = isLog ? logScale(yDomain[0], yDomain[1], 1, 0) : linearScale(yDomain[0], yDomain[1], 1, 0, yCount);
  const yLabelWidth = Math.max(0, ...yProbe.ticks.map((t) => textWidth(t.label, TICK_FONT)));
  const left = Math.ceil(yLabelWidth + 10 + (yTitleText ? LABEL_FONT + 12 : 0));

  bottom += TICK_FONT + 10;
  if (xTitleText) bottom += LABEL_FONT + 12;
  const bottomLegendAt = bottom;
  if (legendNames.length > 0 && spec.legend === "bottom") bottom += 8 + legendRow(0, 0);

  // Line charts label each line at its end when there's room and the labels don't collide.
  const endLabels = spec.type === "line" && seriesColumns.length >= 2 && seriesColumns.length <= 4;
  const endLabelWidth = endLabels ? Math.max(...seriesColumns.map((s) => textWidth(s.spec.name, TICK_FONT))) + 10 : 0;
  const roomForLabels = endLabels && size.width - left - right - endLabelWidth > 240;
  if (roomForLabels) right += endLabelWidth;

  const area = {
    left,
    top,
    width: Math.max(40, size.width - left - right),
    height: Math.max(60, size.height - top - bottom),
  };
  const yScale = isLog
    ? logScale(yDomain[0], yDomain[1], area.top + area.height, area.top)
    : linearScale(yDomain[0], yDomain[1], area.top + area.height, area.top, Math.max(2, Math.round(area.height / 50)));
  const yClamp = (v: number) => Math.min(area.top + area.height, Math.max(area.top, yScale.map(v)));

  // Bottom and right legends are placed now that the plot area is known.
  for (const [i, item] of legend.entries()) {
    if (spec.legend === "bottom") {
      item.x += area.left;
      item.y += area.top + area.height + bottomLegendAt + 6;
    } else if (spec.legend === "right") {
      item.x = size.width - legendRight;
      item.y = area.top + 6 + i * 20;
    } else {
      item.x += area.left;
    }
  }

  let xTicks: Tick[] = [];
  const stops: Stop[] = [];
  const series: PlotSeries[] = [];
  const style = (s: (typeof seriesColumns)[number]) => ({ column: s.spec.column, name: s.spec.name, ...drawStyle(s.spec), ownX: s.ownX });

  if (isBar && xColumn !== undefined) {
    const rows = sharedRows;
    const band = area.width / Math.max(1, rows.length);
    const k = seriesColumns.length;
    const group = Math.min(band * 0.8, k * BAR_MAX + (k - 1) * GAP);
    const barWidth = Math.max(1, (group - (k - 1) * GAP) / k);
    const base = yScale.map(Math.max(yDomain[0], Math.min(yDomain[1], 0)));
    const labels = rows.map((r) => categoryLabel(xColumn, r) ?? "");
    const widest = Math.max(0, ...labels.map((l) => textWidth(l, TICK_FONT)));
    const every = Math.max(1, Math.ceil((widest + 10) / band));
    rows.forEach((r, i) => {
      const center = area.left + band * (i + 0.5);
      stops.push({ row: r, px: center, label: labels[i] });
      if (i % every === 0) xTicks.push({ pos: center, label: labels[i] });
    });
    seriesColumns.forEach((s, si) => {
      const bars: Bar[] = [];
      const whiskers: Whisker[] = [];
      const points: Point[] = [];
      rows.forEach((r, i) => {
        const y = numberAt(s.column, r);
        if (y === null) return;
        const x = area.left + band * (i + 0.5) - group / 2 + si * (barWidth + GAP);
        const end = yClamp(y);
        bars.push({ row: r, x, width: barWidth, top: Math.min(end, base), bottom: Math.max(end, base), path: barPath(x, barWidth, base, end) });
        points.push({ row: r, x: i, y, px: x + barWidth / 2, py: end });
        const e = numberAt(s.error, r);
        if (e !== null) whiskers.push({ px: x + barWidth / 2, top: yClamp(y + Math.abs(e)), bottom: yClamp(y - Math.abs(e)) });
      });
      series.push({ ...style(s), points, path: null, bars, whiskers, markers: false, label: null });
    });
  } else if (xColumn !== undefined) {
    let xLo = Infinity;
    let xHi = -Infinity;
    seriesColumns.forEach((s, si) => {
      for (const r of rowsOf[si]) {
        const x = numberAt(s.x, r);
        if (x === null) continue;
        xLo = Math.min(xLo, x);
        xHi = Math.max(xHi, x);
      }
    });
    const isTime = xColumn.kind === "date";
    if (!Number.isFinite(xLo)) [xLo, xHi] = isTime ? [0, DAY] : [0, 1];
    const xCount = Math.max(2, Math.floor(area.width / 90));
    // A line runs edge to edge over its data; a scatter keeps a little air around its points,
    // so a dot at the first or last value isn't cut in half by the frame.
    const pad = spec.type === "scatter" && xLo < xHi ? (xHi - xLo) * 0.03 : 0;
    const single: [number, number] = isTime ? [xLo - HOUR, xHi + HOUR] : niceDomain(xLo, xHi, xCount);
    const auto: [number, number] = spec.type === "line" && xLo < xHi ? [xLo, xHi] : xLo < xHi ? [xLo - pad, xHi + pad] : single;
    let xDomain: [number, number] = [spec.x.min ?? auto[0], spec.x.max ?? auto[1]];
    if (xDomain[0] >= xDomain[1]) xDomain = auto;
    // A log x (checkSpec refuses zero and below): from the data's own ends, with a little air
    // in log space for dots.
    const isLogX = spec.x.scale === "log" && !isTime && xLo > 0;
    if (isLogX) {
      const air = spec.type === "scatter" && xLo < xHi ? (Math.log10(xHi) - Math.log10(xLo)) * 0.03 : 0;
      const lo = spec.x.min !== null && spec.x.min > 0 ? spec.x.min : xLo / 10 ** air;
      const hi = spec.x.max !== null && spec.x.max > lo ? spec.x.max : xLo < xHi ? xHi * 10 ** air : xLo * 10;
      xDomain = [lo, hi];
    }
    const xScale = isLogX
      ? logScale(xDomain[0], xDomain[1], area.left, area.left + area.width)
      : (isTime ? timeScale : linearScale)(xDomain[0], xDomain[1], area.left, area.left + area.width, xCount);
    xTicks = xScale.ticks;

    for (const r of sharedRows) {
      const x = numberAt(xColumn, r);
      if (x !== null) stops.push({ row: r, px: xScale.map(x), label: xLabel(xColumn, x) });
    }
    seriesColumns.forEach((s, si) => {
      let points: Point[] = [];
      const whiskers: Whisker[] = [];
      const breaks = new Set<number>();
      let gap = false;
      let last = -1;
      for (const r of rowsOf[si]) {
        const x = numberAt(s.x, r);
        const y = numberAt(s.column, r);
        if (x === null || y === null) continue;
        // A blank row between two values breaks the line.
        if (last >= 0 && r > last + 1) gap = true;
        last = r;
        if (isLog && y <= 0) {
          gap = true;
          continue;
        }
        if (gap && points.length > 0) breaks.add(points.length);
        gap = false;
        const py = yScale.map(y);
        points.push({ row: r, x, y, px: xScale.map(x), py });
        const e = numberAt(s.error, r);
        if (e !== null) {
          const err = Math.abs(e);
          whiskers.push({ px: xScale.map(x), top: yClamp(y + err), bottom: isLog && y - err <= 0 ? yClamp(yDomain[0]) : yClamp(y - err) });
        }
      }
      if (spec.type === "scatter" && points.length > MAX_POINTS) {
        const stride = Math.ceil(points.length / MAX_POINTS);
        notes.push(`${s.spec.name}: showing every ${ordinal(stride)} of ${points.length.toLocaleString("en-US")} points.`);
        points = points.filter((_, i) => i % stride === 0);
      }
      const drawn = spec.type === "line" && points.length > area.width * 2 ? thin(points, breaks) : { points, breaks };
      const path = spec.type === "line" ? linePath(drawn.points, drawn.breaks) : null;
      const end = points.at(-1);
      const hover = points.length <= HOVER_POINTS ? points : drawn.points;
      if (s.ownX) for (const p of hover) stops.push({ row: null, px: p.px, label: xLabel(s.x, p.x) });
      // Past six lines a dot on every point is noise; the dash tells the second six apart.
      // Dots on a line only while they have room: at least 10 px apart, or a phone-width chart
      // is a string of beads that hides the line.
      const markers = spec.type === "scatter" || (points.length <= MARKERS_UP_TO && seriesColumns.length <= 6 && area.width / Math.max(1, points.length - 1) >= 10);
      // An error bar shorter than its dot is hidden behind it; say so, or it reads as missing.
      const hidden = markers ? whiskers.filter((w) => w.bottom - w.top < MARKER_SPAN).length : 0;
      if (hidden > 0) {
        const many = hidden > 1;
        notes.push(`${hidden} ${many ? "error bars" : "error bar"} on ${s.spec.name} ${many ? "are" : "is"} shorter than the dot, so ${many ? "they hide" : "it hides"} behind it. Show the numbers lists every value.`);
      }
      series.push({
        ...style(s),
        points: hover,
        path,
        bars: [],
        whiskers,
        markers,
        label: roomForLabels && end !== undefined ? { x: Math.min(end.px, area.left + area.width) + 8, y: end.py } : null,
      });
    });
    stops.sort((a, b) => a.px - b.px || (a.row === null ? 1 : 0) - (b.row === null ? 1 : 0));
    // One stop per place: a shared row wins over a series' own point at the same spot.
    const unique = stops.filter((s, i) => i === 0 || Math.abs(s.px - stops[i - 1].px) > 0.01);
    stops.splice(0, stops.length, ...unique);
    // Labels that would sit on top of each other go; the legend still names every line.
    const ys = series.flatMap((s) => (s.label ? [s.label.y] : [])).sort((a, b) => a - b);
    if (ys.some((y, i) => i > 0 && y - ys[i - 1] < TICK_FONT + 2)) for (const s of series) s.label = null;
  }

  const xTitle = xTitleText ? { text: xTitleText, x: area.left + area.width / 2, y: area.top + area.height + TICK_FONT + 10 + LABEL_FONT + 8, placeholder: xTitleSet === "" } : null;
  const yTitle = yTitleText ? { text: yTitleText, x: LABEL_FONT, y: area.top + area.height / 2, placeholder: yTitleSet === "" } : null;
  const baseline = !isLog && yDomain[0] <= 0 && yDomain[1] >= 0 ? yScale.map(0) : null;

  return {
    width: size.width,
    height: size.height,
    area,
    title,
    xTicks,
    yTicks: yScale.ticks,
    xTitle,
    yTitle,
    baseline,
    series,
    legend,
    legendMark: spec.type === "bar" ? "bar" : spec.type === "scatter" ? "dot" : "line",
    stops,
    notes,
  };
}

// The point of a series the readout shows at a stop: its row when it shares the chart's x and
// the stop is a shared row, otherwise its nearest point along x within reach.
export function pointAt(series: PlotSeries, stop: Stop, reach: number): Point | undefined {
  if (!series.ownX && stop.row !== null) return series.points.find((p) => p.row === stop.row);
  let best: Point | undefined;
  let bestD = reach;
  for (const p of series.points) {
    const d = Math.abs(p.px - stop.px);
    if (d <= bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function ordinal(n: number): string {
  if (n === 2) return "second";
  if (n === 3) return "third";
  return `${n}th`;
}

// Keeps the first, lowest, highest and last point in each pixel column, so a long trace keeps
// its peaks at any width.
function thin(points: Point[], breaks: Set<number>): { points: Point[]; breaks: Set<number> } {
  const out: Point[] = [];
  const outBreaks = new Set<number>();
  let i = 0;
  while (i < points.length) {
    const column = Math.floor(points[i].px);
    let j = i;
    let lo = i;
    let hi = i;
    let broken = false;
    while (j < points.length && Math.floor(points[j].px) === column) {
      if (j > i && breaks.has(j)) broken = true;
      if (points[j].py > points[lo].py) lo = j;
      if (points[j].py < points[hi].py) hi = j;
      j++;
    }
    if (breaks.has(i) || broken) outBreaks.add(out.length);
    for (const k of [...new Set([i, lo, hi, j - 1])].sort((a, b) => a - b)) out.push(points[k]);
    i = j;
  }
  return { points: out, breaks: outBreaks };
}

function linePath(points: Point[], breaks: Set<number>): string {
  return points.map((p, i) => `${i === 0 || breaks.has(i) ? "M" : "L"}${round(p.px)} ${round(p.py)}`).join("");
}

// A bar with 4px rounded corners at its data end and square at the baseline.
export function barPath(x: number, width: number, base: number, end: number): string {
  const h = Math.abs(base - end);
  const r = Math.min(4, width / 2, h);
  const [x0, x1] = [round(x), round(x + width)];
  if (end <= base) {
    return `M${x0} ${round(base)}V${round(end + r)}Q${x0} ${round(end)} ${round(x + r)} ${round(end)}H${round(x + width - r)}Q${x1} ${round(end)} ${x1} ${round(end + r)}V${round(base)}Z`;
  }
  return `M${x0} ${round(base)}V${round(end - r)}Q${x0} ${round(end)} ${round(x + r)} ${round(end)}H${round(x + width - r)}Q${x1} ${round(end)} ${x1} ${round(end - r)}V${round(base)}Z`;
}
