import { analyze, pEq, prepared, SPREAD_WORDS, suggestTest, TEST_NAMES, type Analysis } from "./analysis";
import {
  isSummary,
  type BandSpec,
  type ChartSpec,
  type CurveSpec,
  type DoseSpec,
  type GroupsSpec,
  type HistogramSpec,
  type SummarySpec,
  type Unknowns,
} from "./charts";
import { axisColumns, findColumn, isBookkeepingColumn, isMeanColumn, isSpreadColumn, numberColumns, type DataColumn, type DataTable, type NumberColumn } from "./data-tables";
import type { LayoutId } from "./ids";
import { describeLayout, type SampleLayout } from "./layouts";
import { formatFit, formatValue } from "./numbers";
import { plateLayout, readingColumn, startingSource } from "./plates";
import { groupsOf, sourcesFor, type Grouped, type Source } from "./replicates";

// The guide for charts of repeats (decisions.md, "charts round 1"): the kinds a student picks
// from, which three to suggest for a sheet and why, how each starts, and the sentence and
// warnings under it. lib/chart-guide.ts does the same for charts of plain columns and calls
// into this for the rest.

// What a chart is drawn from: the sheet, the file's other sheets, and the plate's layout when
// there is one (read from the export, painted, or a saved one).
export type PlateMap = { layout: SampleLayout; layoutId: LayoutId | null; from: string };
export type ChartData = { table: DataTable; tables: readonly DataTable[]; layout: PlateMap | null };

export const KINDS = ["line", "bar", "scatter", "dose", "box", "histogram", "heatmap"] as const;
export type ChartKind = (typeof KINDS)[number];

export const KIND_NAMES = {
  line: "Line",
  bar: "Bars",
  scatter: "Scatter",
  dose: "Dose-response",
  box: "Box plot",
  histogram: "Histogram",
  heatmap: "Plate",
} satisfies Record<ChartKind, string>;

export const KIND_QUESTIONS = {
  line: { question: "How something changes", hint: "Over time, or along a run" },
  bar: { question: "Compare groups", hint: "With every repeat shown" },
  scatter: { question: "How two measurements relate", hint: "Like a standard curve, with a fitted line" },
  dose: { question: "How a dose changes the effect", hint: "An S-shaped curve and its IC50" },
  box: { question: "How values spread in each group", hint: "A box plot with every point" },
  histogram: { question: "How values are spread", hint: "How many fall in each range" },
  heatmap: { question: "A whole plate at a glance", hint: "Every well, colored by its value" },
} satisfies Record<ChartKind, { question: string; hint: string }>;

export function kindOf(spec: ChartSpec): ChartKind {
  switch (spec.type) {
    case "line":
    case "band":
      return "line";
    case "bar":
      return "bar";
    case "groups":
      return spec.mark === "box" ? "box" : "bar";
    case "scatter":
    case "curve":
      return "scatter";
    case "dose":
      return "dose";
    case "histogram":
      return "histogram";
    case "heatmap":
      return "heatmap";
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const INDEX = /^(#|no\.?|id|index|row|order|rep|replicate|repeat|well|trial|n|cell|sample no\.?)$/i;
const isMeasure = (c: NumberColumn) => !INDEX.test(c.name.trim()) && !isBookkeepingColumn(c) && !isSpreadColumn(c) && !isMeanColumn(c);

// The repeats a chart of this sheet reads: the plate by its layout, or the sheet's own shape.
export function sourceFor(data: ChartData): Source | null {
  const plate = plateLayout(data.table);
  if (data.layout !== null && plate !== null && plate.kind !== "read" && plate.size === data.layout.layout.size) {
    return { kind: "plate", plate: startingSource(plate, data.table), layout: data.layout.layout, layoutId: data.layout.layoutId };
  }
  if (plate !== null) return null;
  return sourcesFor(data.table)[0] ?? null;
}

// A scatter of two plain columns: the first that can run along the bottom, and the first
// measurement after it.
function pairSource(table: DataTable): Source | null {
  const x = axisColumns(table).find((c) => c.kind === "number" && !INDEX.test(c.name.trim()));
  if (x === undefined) return null;
  const y = numberColumns(table).find((c) => c.id !== x.id && isMeasure(c));
  return y === undefined ? null : { kind: "rows", key: x.id, series: [{ name: y.name, values: [y.id] }] };
}

function valueColumn(table: DataTable): NumberColumn | null {
  return numberColumns(table).find(isMeasure) ?? null;
}

function measuredTitle(grouped: Grouped): { title: string; unit: string } {
  return { title: grouped.measure.name, unit: grouped.measure.unit };
}

// A sheet's own name as an axis title, when it's a name rather than "Table 1".
const sheetTitle = (table: DataTable) => (/^Table \d+$|^Sheet\d*$/i.test(table.name) ? "" : table.name);

const hasBlank = (grouped: Grouped) => grouped.groups.some((g) => g.role === "blank" && g.repeats.length > 0);

// Past this many groups the bars' labels can't be read.
export const MAX_GROUPS = 60;

// A summary chart of this kind, started with what a student would most likely pick; null when
// the sheet can't make it (kindProblem says why).
export function startKind(data: ChartData, kind: ChartKind): SummarySpec | HistogramSpec | null {
  const { table } = data;
  const source = sourceFor(data);
  switch (kind) {
    case "bar":
    case "box": {
      if (source === null) return null;
      const grouped = groupsOf(table, source);
      const live = grouped.groups.filter((g) => g.repeats.length > 0);
      if (live.length < 1 || live.length > MAX_GROUPS) return null;
      const spec: GroupsSpec = {
        version: 1,
        type: "groups",
        mark: kind === "box" ? "box" : "bar",
        source,
        spread: "sd",
        // Every repeat is drawn when there are 10 or fewer; a box plot always shows them.
        points: kind === "box" || live.every((g) => g.repeats.length <= 10),
        blank: hasBlank(grouped),
        test: "none",
        control: null,
        marks: false,
        x: { title: grouped.key.numeric ? grouped.key.name : "" },
        y: { title: grouped.measure.name || sheetTitle(table), unit: grouped.measure.unit, scale: "linear", min: null, max: null },
      };
      const groups = prepared(table, spec).groups;
      const test = suggestTest(groups).test;
      const control = groups.find((g) => g.role === "control")?.label ?? null;
      return { ...spec, test, control };
    }
    case "scatter": {
      const numeric = source !== null && groupsOf(table, source).key.numeric ? source : source === null ? pairSource(table) : null;
      // A curve reads one set of points: the first series of a sheet that has several.
      const s = numeric?.kind === "rows" && numeric.series.length > 1 ? { ...numeric, series: numeric.series.slice(0, 1) } : numeric;
      if (s === null) return null;
      const grouped = groupsOf(table, s);
      const plate = s.kind === "plate";
      const standards = grouped.groups.filter((g) => g.at !== null && (!plate || g.role === "standard"));
      if (standards.length < 2) return null;
      const spec: CurveSpec = {
        version: 1,
        type: "curve",
        source: s,
        spread: "sd",
        points: true,
        blank: hasBlank(grouped),
        fit: "line",
        unknowns: plate ? (grouped.groups.some((g) => g.role === "sample") ? { kind: "layout" } : null) : unknownsElsewhere(data, s),
        x: { title: plate ? "Concentration" : grouped.key.name, unit: grouped.key.unit, scale: "linear", min: null, max: null },
        y: { ...measuredTitle(grouped), scale: "linear", min: null, max: null },
      };
      return spec;
    }
    case "line": {
      if (source === null || source.kind !== "rows" || source.series.every((s) => s.values.length < 2)) return null;
      const grouped = groupsOf(table, source);
      if (!grouped.key.numeric) return null;
      const one = source.series.length === 1;
      const spec: BandSpec = {
        version: 1,
        type: "band",
        source,
        spread: "sd",
        points: false,
        blank: false,
        band: true,
        x: { title: grouped.key.name, unit: grouped.key.unit, scale: "linear", min: null, max: null },
        y: { title: one ? source.series[0].name : grouped.measure.name || sheetTitle(table), unit: grouped.measure.unit, scale: "linear", min: null, max: null },
        legend: "top",
      };
      return spec;
    }
    case "dose": {
      if (source === null) return null;
      const grouped = groupsOf(table, source);
      const key = source.kind === "rows" || source.kind === "long" ? findColumn(table, source.key) : undefined;
      if (key !== undefined && isTimeLike(key)) return null;
      const doses = grouped.groups.filter((g) => g.at !== null && g.at > 0 && (source.kind === "plate" ? g.role === "sample" : g.role !== "control" && g.role !== "blank"));
      if (doses.length < 2) return null;
      const names = [...new Set(doses.map((g) => g.series))];
      const spec: DoseSpec = {
        version: 1,
        type: "dose",
        source,
        spread: "sd",
        points: true,
        blank: hasBlank(grouped),
        fit: "points",
        x: { title: names.length === 1 && names[0] !== "" ? names[0] : source.kind === "plate" ? "Dose" : grouped.key.name, unit: grouped.key.unit, scale: "log", min: null, max: null },
        y: { ...measuredTitle(grouped), scale: "linear", min: null, max: null },
      };
      return spec;
    }
    case "histogram": {
      const plate = plateLayout(table);
      if (plate !== null && plate.kind !== "wells") return null;
      const column = plate?.kind === "wells" ? readingColumn(plate) : source?.kind === "columns" && source.columns.length === 1 ? findColumn(table, source.columns[0]) : valueColumn(table);
      if (column?.kind !== "number" || column.values.filter((v) => v !== null).length < 2) return null;
      const spec: HistogramSpec = {
        version: 1,
        type: "histogram",
        column: column.id,
        bin: null,
        x: { title: column.name, unit: column.unit ?? "", min: null, max: null },
        y: { title: "Count" },
      };
      return spec;
    }
    case "heatmap":
      return null;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

// Another sheet of the file with a reading named like the standards' ("Samples": Sample,
// Dilution, A595), to read off the curve.
function unknownsElsewhere(data: ChartData, source: Source): Unknowns | null {
  const reading = source.kind === "rows" ? source.series[0]?.name : null;
  if (reading === null || reading === undefined) return null;
  const stem = reading.toLowerCase().replace(/\s+/g, " ").trim();
  for (const t of data.tables) {
    if (t === data.table) continue;
    const label = t.columns.find((c) => c.kind === "text");
    const value = numberColumns(t).find((c) => c.name.toLowerCase().trim() === stem);
    if (label === undefined || value === undefined) continue;
    const dilution = numberColumns(t).find((c) => /\bdil/i.test(c.name));
    return { kind: "table", table: t.name, label: label.id, value: value.id, dilution: dilution?.id ?? null };
  }
  return null;
}

// Why this sheet can't make a kind, in a line, or null when it can.
export function kindProblem(data: ChartData, kind: ChartKind): string | null {
  if (startKind(data, kind) !== null) return null;
  const plate = plateLayout(data.table);
  const needsLayout = plate !== null && plate.kind !== "read" && data.layout === null;
  const source = sourceFor(data);
  const groups = source === null ? 0 : groupsOf(data.table, source).groups.filter((g) => g.repeats.length > 0).length;
  const laidOut = data.layout !== null;
  switch (kind) {
    case "bar":
    case "box":
      if (groups > MAX_GROUPS) return `${groups} groups are too many to read side by side.`;
      return needsLayout ? "Mark the plate's wells first, so they can be grouped." : "There are no repeats to group here.";
    case "scatter":
      if (needsLayout) return "Mark the standards on the plate first.";
      return laidOut ? "The layout has no standards with a concentration. Give them one to fit a curve." : "There's no column of numbers to set the readings against.";
    case "line":
      return "There are no repeats along a number or time to draw as a line with its spread.";
    case "dose":
      if (needsLayout) return "Mark the doses on the plate first.";
      return laidOut ? "The layout has no sample at several concentrations." : "There's no series of doses here.";
    case "histogram":
      return plate !== null ? "A plate's wells are better compared as groups or on the plate." : "There's no column of numbers to count.";
    case "heatmap":
      return plate === null ? "This sheet isn't laid out as a plate." : null;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export type KindSuggestion = { kind: ChartKind; reason: string };

// The summary kinds this sheet suggests, best first, each with why in a line.
export function summarySuggestions(data: ChartData): KindSuggestion[] {
  return rawSuggestions(data).filter((s, i, all) => all.findIndex((q) => q.kind === s.kind) === i && (s.kind === "heatmap" || startKind(data, s.kind) !== null));
}

function rawSuggestions(data: ChartData): KindSuggestion[] {
  const out: KindSuggestion[] = [];
  const source = sourceFor(data);
  const plate = plateLayout(data.table);
  if (source === null) {
    const pair = pairSource(data.table);
    const many = valueColumn(data.table);
    const count = many === null ? 0 : many.values.filter((v) => v !== null).length;
    if (plate === null && many !== null && count >= 30 && numberColumns(data.table).filter(isMeasure).length === 1) {
      out.push({ kind: "histogram", reason: `${plural(count, "value")} of ${many.name}, so a histogram shows how they're spread.` });
      out.push({ kind: "box", reason: "A box plot shows the middle half and the spread, with every value." });
    }
    const named = data.table.columns.some((c) => c.kind === "text" || c.kind === "date");
    if (pair !== null && plate === null && !named && startKind(data, "scatter") !== null) {
      const g = groupsOf(data.table, pair);
      if (g.groups.length <= 200) {
        out.push({ kind: "scatter", reason: `Each row pairs ${g.key.name} with ${g.measure.name}, so a scatter with a fitted line shows how they relate, with its R².` });
      }
    }
    return out;
  }
  const grouped = groupsOf(data.table, source);
  const layout = data.layout?.layout ?? null;
  const live = grouped.groups.filter((g) => g.repeats.length > 0);
  const reps = Math.max(0, ...live.map((g) => g.repeats.length));
  const unitWord = source.kind === "plate" ? "wells" : "repeats";
  const each = reps > 1 ? `, ${live.every((g) => g.repeats.length === reps) ? `${reps} ${unitWord} each` : `up to ${reps} ${unitWord} each`}` : "";
  if (source.kind === "plate" && layout !== null) {
    const standards = live.filter((g) => g.role === "standard" && g.at !== null);
    const samples = live.filter((g) => g.role === "sample");
    const named = [...new Set(samples.filter((g) => g.at !== null && g.at > 0).map((g) => g.series))];
    const doses = named.map((n) => samples.filter((g) => g.series === n && g.at !== null && g.at > 0).length);
    if (standards.length >= 2) {
      const lo = Math.min(...standards.map((g) => g.at ?? 0));
      const hi = Math.max(...standards.map((g) => g.at ?? 0));
      const u = layout.unit ? ` ${layout.unit}` : "";
      out.push({
        kind: "scatter",
        reason: `Your layout has ${plural(standards.length, "standard")} from ${formatValue(lo)} to ${formatValue(hi)}${u}${samples.length > 0 ? `, so a standard curve reads your ${plural(samples.length, "sample")} off it` : ", so a standard curve fits a line through them"}.`,
      });
    }
    if (named.length > 0 && Math.max(...doses) >= 3) {
      const control = live.some((g) => g.role === "control");
      out.push({
        kind: "dose",
        reason: `${named[0] || "The sample"} is at ${plural(Math.max(...doses), "concentration")}${control ? " with a control" : ""}${each}, so a dose-response curve finds where it has half its effect (its IC50).`,
      });
    }
    out.push({ kind: "bar", reason: `${describeLayout(layout)}: bars compare them with every well shown.` });
    out.push({ kind: "heatmap", reason: "See every well's reading on the plate." });
    return out;
  }
  if (source.kind === "rows") {
    const repeated = source.series.some((s) => s.values.length >= 2);
    const key = findColumn(data.table, source.key);
    if (grouped.key.numeric && key !== undefined) {
      const ats = live.map((g) => g.at ?? 0);
      const positive = ats.filter((a) => a > 0);
      const decades = positive.length < 2 ? 0 : Math.log10(Math.max(...positive) / Math.min(...positive));
      const timeLike = isTimeLike(key);
      if (repeated && timeLike) out.push({ kind: "line", reason: `Each ${key.name} point has ${reps} repeats, so a line through their means shows the spread as a shaded band.` });
      if (repeated && !timeLike && decades >= 2 && new Set(positive).size >= 5) {
        out.push({ kind: "dose", reason: `${key.name} spans ${Math.round(decades)} tenfold steps${ats.includes(0) ? " with a zero to compare against" : ""}${each}, so a dose-response curve finds its halfway point.` });
      }
      out.push({
        kind: "scatter",
        reason: repeated
          ? `Each ${key.name} value has ${reps} repeats, as in a standard curve, so the chart fits a line through their means.`
          : `Each row pairs ${key.name} with ${grouped.measure.name}, so a scatter with a fitted line shows how they relate.`,
      });
      if (repeated && !timeLike) out.push({ kind: "line", reason: `A line through the means, with the spread of the ${reps} repeats as a band.` });
      return out;
    }
    if (repeated) out.push({ kind: "bar", reason: `${plural(live.length, "row")} with ${reps} repeats each, so bars compare their means with every repeat shown.` });
    out.push({ kind: "box", reason: "A box plot shows each group's middle and spread." });
    return out;
  }
  const groups = live.filter((g) => g.role !== "blank");
  if (groups.length >= 2) {
    out.push({ kind: "bar", reason: `${plural(groups.length, "group")}${each}: bars compare their means with every repeat shown, and the right test says whether the difference is real.` });
    out.push({ kind: "box", reason: "A box plot shows each group's middle and spread, with every point." });
  }
  if (source.kind === "columns" && source.columns.length === 1) {
    const n = live[0]?.repeats.length ?? 0;
    out.unshift({ kind: "histogram", reason: `${plural(n, "value")} of ${live[0]?.label ?? "one column"}, so a histogram shows how they're spread.` });
  }
  return out;
}

const TIME = /time|elapsed|\bday|\bhour|\bminute|\bsecond|\bcycle|\bweek/i;
const TIME_UNIT = /^(s|secs?|seconds?|min|mins|minutes?|h|hrs?|hours?|d|days?|wk|weeks?)$/i;
function isTimeLike(c: DataColumn): boolean {
  return c.kind === "date" || (c.kind === "number" && ((c.unit !== null && TIME_UNIT.test(c.unit.trim())) || TIME.test(c.name)));
}

// ---------------------------------------------------------------------------------------------
// What a summary chart shows, in a sentence or two.

export function describeSummary(spec: SummarySpec | HistogramSpec, data: ChartData, a: Analysis = analyze(data.table, spec, data.tables)): string {
  switch (a.kind) {
    case "groups": {
      if (spec.type !== "groups") return "";
      const groups = a.groups.filter((g) => g.role !== "blank" || !spec.blank);
      const what = spec.y.title ? `${spec.y.title}${spec.y.unit ? ` (${spec.y.unit})` : ""}` : "The readings";
      const ns = [...new Set(groups.map((g) => g.summary.n))];
      const reps = ns.length === 1 ? `${plural(ns[0], "repeat")} each` : `${Math.min(...ns)} to ${Math.max(...ns)} repeats each`;
      const shown = spec.mark === "box" ? "as boxes of their middle half" : `as means with bars showing ${SPREAD_WORDS[spec.spread]}`;
      const points = spec.points ? ", every repeat drawn as a dot" : "";
      const test = a.test.kind === "none" ? "" : ` ${testSentence(a)}`;
      return `${what} for ${listPhrase(groups.map((g) => g.label))}, ${reps}, ${shown}${points}.${a.blank === null ? "" : ` The blank (mean of ${plural(a.blank.n, "well")}) is taken off every reading.`}${test}`;
    }
    case "curve": {
      if (spec.type !== "curve") return "";
      const s = a.standards;
      const u = spec.x.unit ? ` ${spec.x.unit}` : "";
      const reps = [...new Set(s.map((g) => g.summary.n))];
      const lo = s[0]?.at ?? 0;
      const hi = s.at(-1)?.at ?? 0;
      const what = spec.y.title || a.grouped.measure.name || "The reading";
      const each = reps.length === 1 && reps[0] > 1 ? `, each the mean of ${plural(reps[0], "repeat")}` : "";
      const fit = a.fit === null ? "" : `, with a straight line${a.fit.origin ? " through zero" : ""} fitted to them (R² ${a.fit.r2.toFixed(3)})`;
      const unknowns = a.unknowns.length === 0 ? "" : ` ${plural(a.unknowns.length, "sample")} ${a.unknowns.length === 1 ? "is" : "are"} read off the line${a.unknowns.some((k) => k.outside !== null) ? `, ${a.unknowns.filter((k) => k.outside !== null).length} outside your standards` : ""}.`;
      const blank = a.blank === null ? "" : ` The blank (mean of ${plural(a.blank.n, "well")}) is taken off every reading.`;
      const points = spec.source.kind === "plate" ? plural(s.length, "standard") : plural(s.length, `${spec.x.title || "x"} value`);
      return `${what} for ${points} from ${formatValue(lo)} to ${formatValue(hi)}${u}${each}${fit}.${blank}${unknowns}`;
    }
    case "band": {
      if (spec.type !== "band") return "";
      const names = a.series.map((s) => s.name);
      const points = a.series[0]?.groups.length ?? 0;
      const xs = a.series.flatMap((s) => s.groups.map((g) => g.at ?? 0));
      const u = spec.x.unit ? ` ${spec.x.unit}` : "";
      const reps = [...new Set(a.series.flatMap((s) => s.groups.map((g) => g.summary.n)))];
      const span = xs.length === 0 ? "" : ` from ${formatValue(Math.min(...xs))} to ${formatValue(Math.max(...xs))}${u}`;
      return `${listPhrase(names)} as ${spec.x.title || "x"} goes${span}, ${plural(points, "point")}${reps.length === 1 ? `, each the mean of ${plural(reps[0], "repeat")}` : ""}, with ${spec.band ? "a shaded band" : "bars"} showing ${SPREAD_WORDS[spec.spread]}.`;
    }
    case "dose": {
      if (spec.type !== "dose") return "";
      const u = a.unit ? ` ${a.unit}` : "";
      const parts = a.series.map((s) => {
        const ns = [...new Set(s.doses.map((g) => g.summary.n))];
        const lo = s.doses[0]?.at ?? 0;
        const hi = s.doses.at(-1)?.at ?? 0;
        const wells = ns.length === 1 ? `${plural(ns[0], spec.source.kind === "plate" ? "well" : "repeat")} each` : "";
        const v = s.verdict;
        const result =
          v.kind === "ok"
            ? `; ${s.term} ${formatFit(v.mid)}${u} (${formatFit(v.ci[0])} to ${formatFit(v.ci[1])})`
            : v.kind === "unsure"
              ? `; the ${s.term} isn't pinned down`
              : `; no curve could be given`;
        return `${spec.y.title || "The effect"} for ${plural(s.doses.length, "dose")} of ${s.name} from ${formatValue(lo)} to ${formatValue(hi)}${u}${wells ? `, ${wells}` : ""}, fitted with a four-parameter curve${result}.`;
      });
      const blank = a.blank === null ? "" : ` The blank (mean of ${plural(a.blank.n, "well")}) is taken off every reading.`;
      return `${parts.join(" ")}${blank} Bars show ${SPREAD_WORDS[spec.spread]}.`;
    }
    case "histogram": {
      if (spec.type !== "histogram") return "";
      const u = spec.x.unit ? ` ${spec.x.unit}` : "";
      return `How ${plural(a.values.length, "value")} of ${spec.x.title || "the column"} spread from ${formatValue(Math.min(...a.values))} to ${formatValue(Math.max(...a.values))}${u}, counted in bins ${formatValue(a.width)}${u} wide.`;
    }
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

function testSentence(a: Extract<Analysis, { kind: "groups" }>): string {
  const t = a.test;
  switch (t.kind) {
    case "none":
      return "";
    case "cannot":
      return `${TEST_NAMES[t.test]} can't run: ${t.reason}`;
    case "welch":
      return `Welch's t-test compares the two: ${pEq(t.result.p)}.`;
    case "anova":
      return `One-way ANOVA asks whether any group differs: ${pEq(t.result.p)}.`;
    case "control":
      return `Each group is compared with ${t.control.label} by Welch's t-tests, Holm-corrected.`;
    default: {
      const _exhaustive: never = t;
      return _exhaustive;
    }
  }
}

function listPhrase(items: readonly string[], shown = 4): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length <= shown) return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  return `${items.slice(0, shown).join(", ")} and ${items.length - shown} more`;
}

export function summaryWarnings(spec: SummarySpec | HistogramSpec, data: ChartData, a: Analysis = analyze(data.table, spec, data.tables)): string[] {
  const out = [...a.warnings];
  if (isSummary(spec) && spec.points === false && a.kind !== "band" && a.kind !== "histogram") {
    const few = (a.kind === "groups" ? a.groups : a.kind === "curve" ? a.standards : a.series.flatMap((s) => s.doses)).some((g) => g.summary.n <= 10);
    if (few) out.push("Every repeat is hidden. With 10 or fewer, showing them lets a reader judge the spread for themselves.");
  }
  return out;
}

