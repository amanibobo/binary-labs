import { analyze, SPREAD_NAMES, stars, type Analysis, type GroupStat } from "./analysis";
import { SERIES_COLORS, type HistogramSpec, type SeriesColor, type SummarySpec } from "./charts";
import { LABEL_FONT, linearScale, logScale, niceDomain, PLACEHOLDER, textWidth, TICK_FONT, TITLE_FONT, type Scale, type Tick } from "./chart-geometry";
import type { DataTable } from "./data-tables";
import { formatFit, formatValue } from "./numbers";
import { fourPL } from "./stats";

// Where every mark of a chart of repeats goes (decisions.md, "charts round 1"): bars or boxes of
// groups with every repeat as a dot, a standard curve with its line and samples, lines with a
// shaded spread, a dose-response curve and a histogram. Pure, like chart-geometry.ts: the live
// chart, the exported file and the tests draw from the same numbers.

export type Ink = "series" | "soft" | "label" | "tick" | "axis";
export type Dot = { px: number; py: number; color: SeriesColor; r: number; kind: "repeat" | "mean" | "sample" | "outside" };
export type Rule = { x1: number; y1: number; x2: number; y2: number; color: SeriesColor | null; dashed: boolean; width: number };
export type Label = { x: number; y: number; text: string; anchor: "start" | "middle" | "end"; ink: "label" | "tick"; size: number; weight?: number };
export type BarMark = { path: string; color: SeriesColor; soft: boolean };
export type BoxMark = { x: number; width: number; q1: number; q3: number; median: number; low: number; high: number; color: SeriesColor };
export type Whisker = { px: number; top: number; bottom: number; color: SeriesColor };
export type HWhisker = { py: number; left: number; right: number; color: SeriesColor };
export type Band = { path: string; color: SeriesColor };
export type Curve = { path: string; color: SeriesColor; dashed: boolean };
// A place the readout stops at: what's under it and the lines it reads.
export type Target = { px: number; py: number; left: number; right: number; title: string; lines: string[] };
export type LegendEntry = { name: string; color: SeriesColor; mark: "dot" | "line" | "bar" | "sample"; x: number; y: number };
export type TickLabel = { pos: number; lines: string[] };

export type SummaryPlot = {
  width: number;
  height: number;
  area: { left: number; top: number; width: number; height: number };
  title: { text: string; x: number; y: number } | null;
  xTicks: TickLabel[];
  yTicks: Tick[];
  // Vertical grid lines at each x tick (number axes only).
  xGrid: boolean;
  xTitle: { text: string; x: number; y: number; placeholder: boolean } | null;
  yTitle: { text: string; x: number; y: number; placeholder: boolean } | null;
  baseline: number | null;
  bands: Band[];
  bars: BarMark[];
  boxes: BoxMark[];
  curves: Curve[];
  rules: Rule[];
  whiskers: Whisker[];
  hWhiskers: HWhisker[];
  dots: Dot[];
  labels: Label[];
  legend: LegendEntry[];
  targets: Target[];
  // Under the chart in an exported figure: the test, the fit, what the bars show.
  caption: { lines: string[]; y: number; size: number };
  notes: string[];
};

const BAR_MAX = 24;
const BOX_MAX = 40;
const REPEAT_R = 3;
const MEAN_R = 4.5;
const round = (v: number) => Math.round(v * 10) / 10;
// 7 pt at a journal column's width, like the tick labels.
const CAPTION_FONT = 12;

function axisText(title: string, unit: string): string {
  const t = title.trim();
  const u = unit.trim();
  if (t === "") return u;
  return u === "" ? t : `${t} (${u})`;
}

// Words wrapped to a width by the same estimate the axes use.
export function wrap(text: string, width: number, size: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line === "" ? w : `${line} ${w}`;
    if (textWidth(next, size) > width && line !== "") {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line !== "") lines.push(line);
  return lines;
}

// A group's label in at most two lines under its bar.
function tickLines(label: string, band: number): string[] {
  if (textWidth(label, TICK_FONT) <= band - 6) return [label];
  const lines = wrap(label, Math.max(band - 6, 40), TICK_FONT);
  return lines.length <= 2 ? lines : [lines[0], `${lines.slice(1).join(" ").slice(0, Math.max(4, Math.floor((band - 6) / (TICK_FONT * 0.56)) - 1))}…`];
}

type Options = { title?: string; placeholders?: boolean; caption?: boolean };

type Frame = {
  area: SummaryPlot["area"];
  title: SummaryPlot["title"];
  xTitle: SummaryPlot["xTitle"];
  yTitle: SummaryPlot["yTitle"];
  legend: LegendEntry[];
  caption: SummaryPlot["caption"];
  height: number;
};

// The layout outside in: title, legend, side labels, the bottom's ticks and title, the caption.
function frame(
  size: { width: number; height: number },
  opts: Options,
  axes: { x: string; y: string; yLabelWidth: number; xTickLines: number; xPlaceholder?: boolean },
  legendNames: { name: string; color: SeriesColor; mark: LegendEntry["mark"] }[],
  captionLines: readonly string[],
): Frame {
  let top = 8;
  const title = opts.title ? { text: opts.title, x: 0, y: TITLE_FONT + 4 } : null;
  if (title) top += TITLE_FONT + 16;
  const legend: LegendEntry[] = [];
  if (legendNames.length > 0) {
    let x = 0;
    let y = top + 6;
    for (const item of legendNames) {
      const w = 22 + textWidth(item.name, TICK_FONT) + 16;
      if (x + w > size.width && x > 0) {
        x = 0;
        y += 20;
      }
      legend.push({ ...item, x, y });
      x += w;
    }
    top = (legend.at(-1)?.y ?? top) + 20;
  }
  const yText = axes.y || (opts.placeholders ? PLACEHOLDER : "");
  const xText = axes.x || (opts.placeholders && axes.xPlaceholder !== false ? PLACEHOLDER : "");
  const left = Math.ceil(axes.yLabelWidth + 10 + (yText ? LABEL_FONT + 12 : 0));
  const right = 24;
  const tickBlock = TICK_FONT + 10 + (axes.xTickLines - 1) * (TICK_FONT + 2);
  const xTitleBlock = xText ? LABEL_FONT + 12 : 0;
  const capLines = opts.caption ? captionLines.flatMap((l) => wrap(l.charAt(0).toUpperCase() + l.slice(1), size.width, CAPTION_FONT)) : [];
  const capBlock = capLines.length === 0 ? 0 : 20 + capLines.length * (CAPTION_FONT + 4);
  const height = size.height + capBlock;
  const area = { left, top, width: Math.max(40, size.width - left - right), height: Math.max(60, size.height - top - tickBlock - xTitleBlock) };
  for (const item of legend) item.x += area.left;
  const bottom = area.top + area.height;
  return {
    area,
    title,
    legend,
    height,
    xTitle: xText ? { text: xText, x: area.left + area.width / 2, y: bottom + tickBlock + LABEL_FONT + 6, placeholder: axes.x === "" } : null,
    yTitle: yText ? { text: yText, x: LABEL_FONT, y: area.top + area.height / 2, placeholder: axes.y === "" } : null,
    caption: { lines: capLines, y: size.height + 12 + CAPTION_FONT, size: CAPTION_FONT },
  };
}

function yScaleFor(lo: number, hi: number, axis: { scale: "linear" | "log"; min: number | null; max: number | null }, height: number, fromZero: boolean): { domain: [number, number]; probe: (r0: number, r1: number) => Scale } {
  if (axis.scale === "log" && lo > 0) {
    const domain: [number, number] = [axis.min ?? 10 ** Math.floor(Math.log10(lo)), axis.max ?? 10 ** Math.ceil(Math.log10(hi === lo ? hi * 10 : hi))];
    return { domain, probe: (r0, r1) => logScale(domain[0], domain[1], r0, r1) };
  }
  const count = Math.max(2, Math.round(height / 50));
  const nice = niceDomain(fromZero ? Math.min(0, lo) : lo, fromZero ? Math.max(0, hi) : hi, count);
  let domain: [number, number] = [axis.min ?? nice[0], axis.max ?? nice[1]];
  if (domain[0] >= domain[1]) domain = nice;
  return { domain, probe: (r0, r1) => linearScale(domain[0], domain[1], r0, r1, Math.max(2, Math.round(Math.abs(r0 - r1) / 50))) };
}

const labelWidth = (s: Scale) => Math.max(0, ...s.ticks.map((t) => textWidth(t.label, TICK_FONT)));

function barPath(x: number, width: number, base: number, end: number): string {
  const h = Math.abs(base - end);
  const r = Math.min(4, width / 2, h);
  const [x0, x1] = [round(x), round(x + width)];
  const dir = end <= base ? 1 : -1;
  return `M${x0} ${round(base)}V${round(end + dir * r)}Q${x0} ${round(end)} ${round(x + r)} ${round(end)}H${round(x + width - r)}Q${x1} ${round(end)} ${x1} ${round(end + dir * r)}V${round(base)}Z`;
}

// Repeats as a small beeswarm: each dot at the nearest free place beside its group's center.
function swarm(values: readonly number[], center: number, toY: (v: number) => number, half: number, taken: readonly { px: number; py: number }[] = []): { px: number; py: number }[] {
  const placed: { px: number; py: number }[] = [...taken];
  const step = REPEAT_R * 2 + 1;
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<{ px: number; py: number }>(values.length);
  for (const { v, i } of order) {
    const py = toY(v);
    let px = center;
    for (let k = 0; k < 40; k++) {
      const offset = k === 0 ? 0 : (k % 2 === 1 ? -1 : 1) * Math.ceil(k / 2) * step * 0.6;
      if (Math.abs(offset) > half) break;
      const candidate = center + offset;
      if (placed.every((p) => Math.hypot(p.px - candidate, p.py - py) >= step)) {
        px = candidate;
        break;
      }
      px = candidate;
    }
    placed.push({ px, py });
    out[i] = { px: round(px), py: round(py) };
  }
  return out;
}

function spreadLine(g: GroupStat, spread: SummarySpec["spread"], unit: string): string {
  const u = unit ? ` ${unit}` : "";
  return g.half === null ? `Mean ${formatFit(g.summary.mean)}${u} (one value, so no ${SPREAD_NAMES[spread]})` : `Mean ${formatFit(g.summary.mean)} ± ${formatFit(g.half)}${u} (${SPREAD_NAMES[spread]})`;
}

function repeatsLine(g: GroupStat): string {
  const shown = g.repeats.slice(0, 8).map((r) => `${r.where} ${formatValue(r.value)}`);
  return `n = ${g.summary.n}: ${shown.join(", ")}${g.repeats.length > 8 ? ", …" : ""}`;
}

export function plotSummary(spec: SummarySpec | HistogramSpec, table: DataTable, size: { width: number; height: number }, opts: Options = {}, tables: readonly DataTable[] = [table]): SummaryPlot {
  const a = analyze(table, spec, tables);
  switch (a.kind) {
    case "groups":
      return spec.type === "groups" ? plotGroups(spec, a, size, opts) : empty(size);
    case "curve":
      return spec.type === "curve" ? plotXY(spec, a, size, opts) : empty(size);
    case "band":
      return spec.type === "band" ? plotXY(spec, a, size, opts) : empty(size);
    case "dose":
      return spec.type === "dose" ? plotXY(spec, a, size, opts) : empty(size);
    case "histogram":
      return spec.type === "histogram" ? plotHistogram(spec, a, size, opts) : empty(size);
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

function empty(size: { width: number; height: number }): SummaryPlot {
  return {
    width: size.width,
    height: size.height,
    area: { left: 0, top: 0, width: size.width, height: size.height },
    title: null,
    xTicks: [],
    yTicks: [],
    xGrid: false,
    xTitle: null,
    yTitle: null,
    baseline: null,
    bands: [],
    bars: [],
    boxes: [],
    curves: [],
    rules: [],
    whiskers: [],
    hWhiskers: [],
    dots: [],
    labels: [],
    legend: [],
    targets: [],
    caption: { lines: [], y: 0, size: CAPTION_FONT },
    notes: [],
  };
}

// ---------------------------------------------------------------------------------------------

function plotGroups(spec: Extract<SummarySpec, { type: "groups" }>, a: Extract<Analysis, { kind: "groups" }>, size: { width: number; height: number }, opts: Options): SummaryPlot {
  const out = empty(size);
  const groups = a.groups.filter((g) => !(spec.blank && g.role === "blank"));
  const isBox = spec.mark === "box";
  const values = groups.flatMap((g) => g.repeats.map((r) => r.value));
  const tops = groups.map((g) => g.summary.mean + (g.half ?? 0));
  const bottoms = groups.map((g) => g.summary.mean - (g.half ?? 0));
  const markRoom = spec.marks && (a.test.kind === "welch" || a.test.kind === "control") ? 1 : 0;
  let lo = Math.min(...values, ...(isBox ? [] : bottoms));
  let hi = Math.max(...values, ...(isBox ? [] : tops));
  if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
  if (markRoom) hi += (hi - Math.min(0, lo)) * 0.14;
  const guess = Math.max(80, size.height - 120);
  const y = yScaleFor(lo, hi, spec.y, guess, !isBox);
  const probe = y.probe(1, 0);
  const band0 = (size.width - labelWidth(probe) - 60) / Math.max(1, groups.length);
  const tickLabels = groups.map((g) => tickLines(g.label, band0));
  // The groups name themselves under their bars, so an empty bottom title stays empty rather
  // than asking to be named.
  const f = frame(
    size,
    opts,
    { x: spec.x.title, y: axisText(spec.y.title, spec.y.unit), yLabelWidth: labelWidth(probe), xTickLines: Math.max(1, ...tickLabels.map((l) => l.length)), xPlaceholder: false },
    [],
    opts.caption ? a.caption : [],
  );
  const { area } = f;
  const yScale = y.probe(area.top + area.height, area.top);
  const clamp = (v: number) => Math.min(area.top + area.height, Math.max(area.top, yScale.map(v)));
  const band = area.width / Math.max(1, groups.length);
  const width = Math.min(band * (isBox ? 0.5 : 0.6), isBox ? BOX_MAX : BAR_MAX);
  const base = clamp(Math.max(y.domain[0], Math.min(y.domain[1], 0)));
  const color: SeriesColor = SERIES_COLORS[0];
  groups.forEach((g, i) => {
    const center = area.left + band * (i + 0.5);
    out.xTicks.push({ pos: center, lines: tickLabels[i] });
    const lines: string[] = [];
    if (isBox) {
      const box = a.boxes[a.groups.indexOf(g)];
      if (box !== null && box !== undefined) {
        out.boxes.push({ x: center - width / 2, width, q1: clamp(box.q1), q3: clamp(box.q3), median: clamp(box.median), low: clamp(box.low), high: clamp(box.high), color });
        lines.push(`Median ${formatFit(box.median)}, middle half ${formatFit(box.q1)} to ${formatFit(box.q3)}`);
        if (box.outliers.length > 0) lines.push(`${box.outliers.length} past the whiskers: ${box.outliers.slice(0, 5).map(formatValue).join(", ")}`);
        if (!spec.points) for (const o of box.outliers) out.dots.push({ px: center, py: clamp(o), color, r: REPEAT_R, kind: "repeat" });
      }
    } else if (g.summary.n > 0) {
      const end = clamp(g.summary.mean);
      out.bars.push({ path: barPath(center - width / 2, width, base, end), color, soft: spec.points });
      if (g.half !== null) out.whiskers.push({ px: center, top: clamp(g.summary.mean + g.half), bottom: clamp(g.summary.mean - g.half), color });
      lines.push(spreadLine(g, spec.spread, spec.y.unit));
    }
    if (spec.points) {
      for (const p of swarm(g.repeats.map((r) => r.value), center, clamp, Math.max(width / 2, 8))) out.dots.push({ ...p, color, r: REPEAT_R, kind: "repeat" });
    }
    lines.push(repeatsLine(g));
    out.targets.push({ px: center, py: clamp(g.summary.mean), left: center - band / 2, right: center + band / 2, title: g.label, lines });
  });
  // Stars only with the test named under the chart (the caption, and the facts beside it).
  if (spec.marks) {
    const above = (g: GroupStat) => Math.min(...g.repeats.map((r) => clamp(r.value)), clamp(g.summary.mean + (g.half ?? 0)), isBox ? (a.boxes[a.groups.indexOf(g)] ? clamp(a.boxes[a.groups.indexOf(g)]?.high ?? 0) : Infinity) : Infinity);
    if (a.test.kind === "control") {
      for (const c of a.test.comparisons) {
        const i = groups.findIndex((g) => g.label === c.label);
        if (i < 0) continue;
        out.labels.push({ x: area.left + band * (i + 0.5), y: above(groups[i]) - 8, text: stars(c.adjusted), anchor: "middle", ink: "label", size: TICK_FONT });
      }
    } else if (a.test.kind === "welch") {
      const [i, j] = [groups.indexOf(a.test.a), groups.indexOf(a.test.b)];
      if (i >= 0 && j >= 0) {
        const yb = Math.min(above(groups[i]), above(groups[j])) - 14;
        const [x1, x2] = [area.left + band * (i + 0.5), area.left + band * (j + 0.5)];
        out.rules.push({ x1, y1: yb + 5, x2: x1, y2: yb, color: null, dashed: false, width: 1 }, { x1, y1: yb, x2, y2: yb, color: null, dashed: false, width: 1 }, { x1: x2, y1: yb, x2, y2: yb + 5, color: null, dashed: false, width: 1 });
        out.labels.push({ x: (x1 + x2) / 2, y: yb - 5, text: stars(a.test.result.p), anchor: "middle", ink: "label", size: TICK_FONT });
      }
    }
  }
  return finish(out, f, yScale, y.domain, spec.y.scale === "log", size);
}

function finish(out: SummaryPlot, f: Frame, yScale: Scale, domain: [number, number], log: boolean, size: { width: number; height: number }): SummaryPlot {
  return {
    ...out,
    width: size.width,
    height: f.height,
    area: f.area,
    title: f.title,
    yTicks: yScale.ticks,
    xTitle: f.xTitle,
    yTitle: f.yTitle,
    baseline: !log && domain[0] <= 0 && domain[1] >= 0 ? yScale.map(0) : null,
    legend: f.legend,
    caption: f.caption,
  };
}

// ---------------------------------------------------------------------------------------------
// Number along the bottom: a standard curve, lines with a band, a dose-response curve.

type XYish = Extract<SummarySpec, { type: "curve" | "band" | "dose" }>;
type XYAnalysis = Extract<Analysis, { kind: "curve" | "band" | "dose" }>;

function plotXY(spec: XYish, a: XYAnalysis, size: { width: number; height: number }, opts: Options): SummaryPlot {
  const out = empty(size);
  const sets: { name: string; color: SeriesColor; groups: GroupStat[] }[] =
    a.kind === "curve"
      ? [{ name: a.unknowns.length > 0 ? "Standards" : a.grouped.measure.name || "Mean", color: SERIES_COLORS[0], groups: a.standards }]
      : a.kind === "band"
        ? a.series.map((s, i) => ({ name: s.name, color: SERIES_COLORS[i % SERIES_COLORS.length], groups: s.groups }))
        : a.series.map((s, i) => ({ name: s.name, color: SERIES_COLORS[i % SERIES_COLORS.length], groups: s.doses }));
  const unknowns = a.kind === "curve" ? a.unknowns.filter((u) => u.conc !== null) : [];
  const logX = spec.x.scale === "log";
  const xs = [...sets.flatMap((s) => s.groups.map((g) => g.at ?? 0)), ...unknowns.map((u) => u.conc ?? 0)].filter((x) => !logX || x > 0);
  const ys = [
    ...sets.flatMap((s) => s.groups.flatMap((g) => [g.summary.mean + (g.half ?? 0), g.summary.mean - (g.half ?? 0), ...(spec.points ? g.repeats.map((r) => r.value) : [])])),
    ...unknowns.map((u) => u.reading),
  ];
  const controls = a.kind === "dose" ? [...new Set(a.series.map((s) => s.control).filter((c): c is GroupStat => c !== null))] : [];
  for (const c of controls) ys.push(c.summary.mean);
  const curveParams = a.kind === "dose" ? a.series.map((s) => (s.verdict.kind === "none" ? null : s.params)) : [];
  for (const p of curveParams) if (p !== null) ys.push(p.top, p.bottom);
  let xLo = Math.min(...xs);
  let xHi = Math.max(...xs);
  if (!Number.isFinite(xLo)) [xLo, xHi] = logX ? [1, 10] : [0, 1];
  let yLo = Math.min(...ys);
  let yHi = Math.max(...ys);
  if (!Number.isFinite(yLo)) [yLo, yHi] = [0, 1];
  const fromZero = a.kind === "curve" && spec.y.scale !== "log";
  const y = yScaleFor(yLo, yHi, spec.y, Math.max(80, size.height - 120), fromZero);
  const legendNames: { name: string; color: SeriesColor; mark: LegendEntry["mark"] }[] =
    a.kind === "curve" && unknowns.length > 0
      ? [
          { name: "Standards", color: SERIES_COLORS[0], mark: "dot" },
          { name: "Samples", color: SERIES_COLORS[1], mark: "sample" },
        ]
      : sets.length >= 2
        ? sets.map((s) => ({ name: s.name, color: s.color, mark: "line" as const }))
        : [];
  const f = frame(size, opts, { x: axisText(spec.x.title, spec.x.unit), y: axisText(spec.y.title, spec.y.unit), yLabelWidth: labelWidth(y.probe(1, 0)), xTickLines: 1 }, legendNames, opts.caption ? a.caption : []);
  const { area } = f;
  const yScale = y.probe(area.top + area.height, area.top);
  const clampY = (v: number) => Math.min(area.top + area.height, Math.max(area.top, yScale.map(v)));
  let xDomain: [number, number];
  if (logX) {
    const pad = Math.max(0.15, (Math.log10(xHi) - Math.log10(xLo)) * 0.06);
    xDomain = [spec.x.min !== null && spec.x.min > 0 ? spec.x.min : xLo / 10 ** pad, spec.x.max ?? xHi * 10 ** pad];
  } else {
    const pad = (xHi - xLo) * 0.04 || 1;
    const nice = niceDomain(a.kind === "curve" ? Math.min(0, xLo) : xLo - (a.kind === "band" ? 0 : pad), xHi + (a.kind === "band" ? 0 : pad), Math.max(2, Math.floor(area.width / 90)));
    xDomain = a.kind === "band" && xLo < xHi ? [spec.x.min ?? xLo, spec.x.max ?? xHi] : [spec.x.min ?? nice[0], spec.x.max ?? nice[1]];
  }
  if (xDomain[0] >= xDomain[1]) xDomain = [xDomain[0], xDomain[0] + 1];
  const xScale = logX ? logScale(xDomain[0], xDomain[1], area.left, area.left + area.width) : linearScale(xDomain[0], xDomain[1], area.left, area.left + area.width, Math.max(2, Math.floor(area.width / 90)));
  const mapX = (v: number) => xScale.map(v);
  out.xTicks = xScale.ticks.map((t) => ({ pos: t.pos, lines: [t.label] }));
  out.xGrid = false;
  const u = spec.x.unit ? ` ${spec.x.unit}` : "";

  // Controls: zero has no place on a log scale, so a dashed line at their mean.
  for (const c of controls) {
    const py = clampY(c.summary.mean);
    out.rules.push({ x1: area.left, y1: py, x2: area.left + area.width, y2: py, color: null, dashed: true, width: 1 });
    out.labels.push({ x: area.left + 6, y: py - 6, text: `${c.label}, no drug: ${formatFit(c.summary.mean)}`, anchor: "start", ink: "tick", size: TICK_FONT });
    out.targets.push({ px: area.left + 4, py, left: area.left, right: area.left + 8, title: `${c.label} (no drug)`, lines: [spreadLine(c, spec.spread, spec.y.unit), repeatsLine(c)] });
  }

  sets.forEach((set, si) => {
    const pts = set.groups.filter((g) => g.at !== null && (!logX || (g.at ?? 0) > 0));
    if (a.kind === "band") {
      const line = pts.map((g, i) => `${i === 0 ? "M" : "L"}${round(mapX(g.at ?? 0))} ${round(clampY(g.summary.mean))}`).join("");
      if (spec.type === "band" && spec.band) {
        const upper = pts.map((g) => `${round(mapX(g.at ?? 0))} ${round(clampY(g.summary.mean + (g.half ?? 0)))}`);
        const lower = [...pts].reverse().map((g) => `${round(mapX(g.at ?? 0))} ${round(clampY(g.summary.mean - (g.half ?? 0)))}`);
        if (pts.length >= 2) out.bands.push({ path: `M${upper.join("L")}L${lower.join("L")}Z`, color: set.color });
      }
      if (pts.length >= 2) out.curves.push({ path: line, color: set.color, dashed: false });
    }
    for (const g of pts) {
      const px = mapX(g.at ?? 0);
      const py = clampY(g.summary.mean);
      const showBars = a.kind !== "band" || (spec.type === "band" && !spec.band);
      if (showBars && g.half !== null) out.whiskers.push({ px, top: clampY(g.summary.mean + g.half), bottom: clampY(g.summary.mean - g.half), color: set.color });
      // Repeats beside their mean, nudged apart where they'd sit on top of each other.
      if (spec.points) for (const p of swarm(g.repeats.map((r) => r.value), px, clampY, 9, [{ px, py }])) out.dots.push({ ...p, color: set.color, r: REPEAT_R - 0.5, kind: "repeat" });
      if (a.kind !== "band" || pts.length <= 40) out.dots.push({ px, py, color: set.color, r: a.kind === "band" ? 3.5 : MEAN_R, kind: "mean" });
      out.targets.push({ px, py, left: px - 12, right: px + 12, title: `${sets.length > 1 ? `${set.name}, ` : ""}${spec.x.title || "at"} ${formatValue(g.at ?? 0)}${u}`, lines: [spreadLine(g, spec.spread, spec.y.unit), repeatsLine(g)] });
    }
    if (a.kind === "dose") {
      const s = a.series[si];
      const p = curveParams[si];
      if (p !== null && p !== undefined) {
        const steps = 160;
        const [l0, l1] = [Math.log10(xDomain[0]), Math.log10(xDomain[1])];
        const path: string[] = [];
        for (let k = 0; k <= steps; k++) {
          const lx = l0 + ((l1 - l0) * k) / steps;
          path.push(`${k === 0 ? "M" : "L"}${round(mapX(10 ** lx))} ${round(clampY(fourPL(p, lx)))}`);
        }
        out.curves.push({ path: path.join(""), color: set.color, dashed: s?.verdict.kind !== "ok" });
        if (s?.verdict.kind === "ok") {
          const mx = mapX(s.verdict.mid);
          const my = clampY((p.top + p.bottom) / 2);
          out.rules.push({ x1: mx, y1: my, x2: mx, y2: area.top + area.height, color: set.color, dashed: true, width: 1 });
          out.hWhiskers.push({ py: my, left: mapX(s.verdict.ci[0]), right: mapX(s.verdict.ci[1]), color: set.color });
          const text = `${s.term} ${formatFit(s.verdict.mid)}${u}`;
          const tx = Math.min(area.left + area.width - textWidth(text, TICK_FONT) - 4, mx + 8);
          out.labels.push({ x: tx, y: my - 8 - si * 16, text, anchor: "start", ink: "label", size: TICK_FONT, weight: 600 });
          out.targets.push({
            px: mx,
            py: my,
            left: mx - 6,
            right: mx + 6,
            title: `${s.term} of ${s.name}`,
            lines: [`${formatFit(s.verdict.mid)}${u}, 95% CI ${formatFit(s.verdict.ci[0])} to ${formatFit(s.verdict.ci[1])}`, `Top ${formatFit(p.top)}, bottom ${formatFit(p.bottom)}, Hill slope ${formatFit(p.hill)}`],
          });
        }
      }
    }
  });

  if (a.kind === "curve" && a.fit !== null) {
    const fit = a.fit;
    const line = (x0: number, x1: number): string => {
      const steps = logX ? 80 : 1;
      const path: string[] = [];
      for (let k = 0; k <= steps; k++) {
        const x = logX ? 10 ** (Math.log10(x0) + ((Math.log10(x1) - Math.log10(x0)) * k) / steps) : x0 + ((x1 - x0) * k) / steps;
        path.push(`${k === 0 ? "M" : "L"}${round(mapX(x))} ${round(clampY(fit.intercept + fit.slope * x))}`);
      }
      return path.join("");
    };
    // Solid across the standards, where the line is measured; dashed past them, where a
    // sample read off it is a guess.
    const [lo, hi] = a.range ?? [xDomain[0], xDomain[1]];
    const start = logX ? xDomain[0] : Math.max(xDomain[0], fit.origin ? 0 : xDomain[0]);
    out.curves.push({ path: line(lo, hi), color: SERIES_COLORS[0], dashed: false });
    if (start < lo) out.curves.push({ path: line(start, lo), color: SERIES_COLORS[0], dashed: true });
    if (xDomain[1] > hi) out.curves.push({ path: line(hi, xDomain[1]), color: SERIES_COLORS[0], dashed: true });
    const sign = fit.intercept < 0 ? "−" : "+";
    const eq = fit.origin ? `y = ${formatFit(fit.slope)}x` : `y = ${formatFit(fit.slope)}x ${sign} ${formatFit(Math.abs(fit.intercept))}`;
    out.labels.push({ x: area.left + 8, y: area.top + 14, text: eq, anchor: "start", ink: "label", size: TICK_FONT, weight: 600 });
    out.labels.push({ x: area.left + 8, y: area.top + 30, text: `R² = ${fit.r2.toFixed(4)}`, anchor: "start", ink: "label", size: TICK_FONT });
    for (const k of unknowns) {
      const px = mapX(k.conc ?? 0);
      const py = clampY(k.reading);
      out.rules.push({ x1: px, y1: py, x2: px, y2: area.top + area.height, color: SERIES_COLORS[1], dashed: true, width: 1 });
      out.dots.push({ px, py, color: SERIES_COLORS[1], r: MEAN_R, kind: k.outside === null ? "sample" : "outside" });
      const amount = `${formatFit(k.conc ?? 0)}${u} in the well${k.dilution !== null && k.dilution !== 1 ? `, × ${formatValue(k.dilution)} = ${formatFit(k.original ?? 0)}${u}` : ""}`;
      out.targets.push({
        px,
        py,
        left: px - 12,
        right: px + 12,
        title: k.label,
        lines: [`Reads ${formatFit(k.reading)}${k.n > 1 ? ` (mean of ${k.n})` : ""}`, amount, ...(k.outside === null ? [] : ["Outside your standards, so this number is a guess."])],
      });
    }
  }
  out.targets.sort((p, q) => p.px - q.px);
  return finish(out, f, yScale, y.domain, spec.y.scale === "log", size);
}

// ---------------------------------------------------------------------------------------------

function plotHistogram(spec: HistogramSpec, a: Extract<Analysis, { kind: "histogram" }>, size: { width: number; height: number }, opts: Options): SummaryPlot {
  const out = empty(size);
  const hi = Math.max(1, ...a.counts);
  const y = yScaleFor(0, hi, { scale: "linear", min: null, max: null }, Math.max(80, size.height - 120), true);
  const f = frame(size, opts, { x: axisText(spec.x.title, spec.x.unit), y: spec.y.title, yLabelWidth: labelWidth(y.probe(1, 0)), xTickLines: 1 }, [], opts.caption ? a.caption : []);
  const { area } = f;
  const yScale = y.probe(area.top + area.height, area.top);
  const lo = spec.x.min ?? a.edges[0] ?? 0;
  const top = spec.x.max ?? a.edges.at(-1) ?? 1;
  const xScale = linearScale(lo, top > lo ? top : lo + 1, area.left, area.left + area.width, Math.max(2, Math.floor(area.width / 80)));
  out.xTicks = xScale.ticks.map((t) => ({ pos: t.pos, lines: [t.label] }));
  const base = yScale.map(0);
  const u = spec.x.unit ? ` ${spec.x.unit}` : "";
  a.counts.forEach((count, i) => {
    const x0 = xScale.map(a.edges[i]);
    const x1 = xScale.map(a.edges[i + 1]);
    if (x1 < area.left || x0 > area.left + area.width) return;
    const left = Math.max(area.left, x0) + 1;
    const width = Math.max(1, Math.min(area.left + area.width, x1) - left - 1);
    if (count > 0) out.bars.push({ path: barPath(left, width, base, yScale.map(count)), color: SERIES_COLORS[0], soft: false });
    out.targets.push({
      px: left + width / 2,
      py: yScale.map(count),
      left: x0,
      right: x1,
      title: `${formatValue(a.edges[i])} to ${formatValue(a.edges[i + 1])}${u}`,
      lines: [`${count} of ${a.values.length} (${((100 * count) / a.values.length).toFixed(1)}%)`],
    });
  });
  return finish(out, f, yScale, y.domain, false, size);
}
