import type { BandSpec, CurveSpec, DoseSpec, GroupsSpec, HistogramSpec, Spread, SummarySpec, TestChoice } from "./charts";
import { findColumn, type DataTable } from "./data-tables";
import { formatFit, formatP, formatValue } from "./numbers";
import { blankOf, groupsOf, subtractBlank, summarized, type Blank, type Grouped, type Summarized } from "./replicates";
import {
  anova,
  binCounts,
  binEdges,
  boxStats,
  fitDose,
  fitLine,
  holm,
  quantile,
  rawBinWidth,
  roundWidth,
  welch,
  type Box,
  type DoseFit,
  type FourPL,
  type LineFit,
  type TestResult,
} from "./stats";

// What a summary chart computes from its repeats (decisions.md, "charts round 1"): the groups
// and their spreads, the test, the fit, the unknowns read off a curve, and each result as a
// plain question with its technical answer and a one-sentence explanation. Pure, so the chart,
// its sentence, its export and its CSV all say the same thing.

export const SPREAD_NAMES = { sd: "SD", sem: "SEM", ci: "95% CI" } satisfies Record<Spread, string>;
export const SPREAD_WORDS = {
  sd: "how much the repeats vary (SD)",
  sem: "how precisely each mean is known (SEM)",
  ci: "where each true mean likely lies (95% CI)",
} satisfies Record<Spread, string>;
export const SPREAD_HELP = {
  sd: "Standard deviation: how far a typical repeat sits from the mean. It doesn't shrink with more repeats.",
  sem: "Standard error of the mean: the SD divided by √n. It shrinks as you add repeats, so it says how sure the mean is, not how much the repeats vary.",
  ci: "95% confidence interval: if you ran the experiment many times, 95% of ranges worked out this way would hold the true mean. From the t distribution, so it's wider for few repeats.",
} satisfies Record<Spread, string>;

export const TEST_NAMES = {
  none: "No test",
  welch: "Welch's t-test",
  anova: "One-way ANOVA",
  control: "Each against the control (Welch's t-tests, Holm-corrected)",
} satisfies Record<TestChoice, string>;

// One result, plain question first, its technical answer second, and what the term means.
export type Fact = { question: string; answer: string; explain: string };

export type GroupStat = Summarized & { half: number | null };

export function spreadOf(g: Summarized, spread: Spread): number | null {
  return spread === "sd" ? g.summary.sd : spread === "sem" ? g.summary.sem : g.summary.ci;
}

function withSpread(groups: Summarized[], spread: Spread): GroupStat[] {
  return groups.map((g) => ({ ...g, half: spreadOf(g, spread) }));
}

// The source's groups, with the blank taken off when asked and there is one.
export function prepared(table: DataTable, spec: SummarySpec): { grouped: Grouped; blank: Blank | null; groups: GroupStat[] } {
  const grouped = groupsOf(table, spec.source);
  const blank = blankOf(grouped.groups);
  const groups = spec.blank && blank !== null ? subtractBlank(grouped.groups, blank) : grouped.groups;
  return { grouped, blank: spec.blank ? blank : null, groups: withSpread(summarized(groups), spec.spread) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function nPhrase(groups: readonly GroupStat[], unit = "per group"): string {
  const ns = groups.map((g) => g.summary.n);
  const lo = Math.min(...ns);
  const hi = Math.max(...ns);
  return lo === hi ? `n = ${lo} ${unit}` : `n = ${lo} to ${hi} ${unit}`;
}

// "if there were no real difference, a gap this big would come up by chance about 3 times in
// 1,000 experiments like this one".
export function explainP(p: number): string {
  const chance =
    p < 0.0001
      ? "less than once in 10,000"
      : p < 0.001
        ? `about ${Math.max(1, Math.round(p * 10_000))} times in 10,000`
        : p < 0.01
          ? `about ${Math.max(1, Math.round(p * 1000))} times in 1,000`
          : p < 0.1
            ? `about ${Math.max(1, Math.round(p * 100))} times in 100`
            : `about ${Math.max(1, Math.round(p * 10))} times in 10`;
  return `p: if there were no real difference, a gap this big would turn up by chance ${chance} experiments like this one. Below 0.05 is usually called significant.`;
}

export function stars(p: number): string {
  return p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "ns";
}

// ---------------------------------------------------------------------------------------------
// Groups: bars or boxes, and a test.

export type Comparison = { label: string; n: number; p: number; adjusted: number };
export type TestOutcome =
  | { kind: "none" }
  | { kind: "welch"; a: GroupStat; b: GroupStat; result: Extract<TestResult, { kind: "ok" }> }
  | { kind: "anova"; result: Extract<TestResult, { kind: "ok" }>; groups: GroupStat[] }
  | { kind: "control"; control: GroupStat; comparisons: Comparison[] }
  | { kind: "cannot"; test: TestChoice; reason: string };

export type Suggestion = { test: TestChoice; reason: string };

// The test that fits the groups, and why, in a line.
export function suggestTest(groups: readonly GroupStat[]): Suggestion {
  const compared = groups.filter((g) => g.role !== "blank");
  if (compared.length < 2) return { test: "none", reason: "There's one group, so nothing to compare." };
  if (compared.some((g) => g.role === "standard")) return { test: "none", reason: "Standards are known amounts, so there's nothing to test between them." };
  if (compared.every((g) => g.summary.n < 2)) return { test: "none", reason: "Each group has a single value, so no test can tell a real difference from chance." };
  if (compared.length === 2) return { test: "welch", reason: "Two groups, so Welch's t-test. It doesn't assume they vary by the same amount." };
  const control = compared.find((g) => g.role === "control");
  if (control !== undefined) {
    return {
      test: "control",
      reason: `${compared.length - 1} groups and a control, so each is compared with ${control.label}: Welch's t-tests, corrected with Holm's method for testing ${compared.length - 1} at once.`,
    };
  }
  return { test: "anova", reason: `${compared.length} groups, so one-way ANOVA: does any group's mean differ from the others?` };
}

export function controlGroup(groups: readonly GroupStat[], label: string | null): GroupStat | null {
  const compared = groups.filter((g) => g.role !== "blank");
  return compared.find((g) => g.label === label) ?? compared.find((g) => g.role === "control") ?? null;
}

export function runTest(groups: readonly GroupStat[], test: TestChoice, control: string | null): TestOutcome {
  const compared = groups.filter((g) => g.role !== "blank" && g.summary.n > 0);
  const values = (g: GroupStat) => g.repeats.map((r) => r.value);
  switch (test) {
    case "none":
      return { kind: "none" };
    case "welch": {
      if (compared.length !== 2) return { kind: "cannot", test, reason: `Welch's t-test compares exactly 2 groups, and this chart has ${compared.length}.` };
      const [a, b] = compared;
      const result = welch(values(a), values(b));
      return result.kind === "ok" ? { kind: "welch", a, b, result } : { kind: "cannot", test, reason: result.reason };
    }
    case "anova": {
      if (compared.length < 3) return { kind: "cannot", test, reason: "One-way ANOVA is for 3 or more groups. For 2, use Welch's t-test." };
      const result = anova(compared.map(values));
      return result.kind === "ok" ? { kind: "anova", result, groups: compared } : { kind: "cannot", test, reason: result.reason };
    }
    case "control": {
      const c = controlGroup(compared, control);
      if (c === null) return { kind: "cannot", test, reason: "Mark one group as the control first." };
      const others = compared.filter((g) => g !== c);
      if (others.length === 0) return { kind: "cannot", test, reason: "There's nothing to compare with the control." };
      const raw: { label: string; n: number; p: number }[] = [];
      for (const g of others) {
        const r = welch(values(g), values(c));
        if (r.kind !== "ok") return { kind: "cannot", test, reason: `${g.label}: ${r.reason}` };
        raw.push({ label: g.label, n: g.summary.n, p: r.p });
      }
      const adjusted = holm(raw.map((r) => r.p));
      return { kind: "control", control: c, comparisons: raw.map((r, i) => ({ ...r, adjusted: adjusted[i] })) };
    }
    default: {
      const _exhaustive: never = test;
      return _exhaustive;
    }
  }
}

export type GroupsAnalysis = {
  kind: "groups";
  groups: GroupStat[];
  blank: Blank | null;
  measure: Grouped["measure"];
  test: TestOutcome;
  suggested: Suggestion;
  boxes: (Box | null)[];
  facts: Fact[];
  warnings: string[];
  // The line under the chart and its export that names the test.
  caption: string[];
};

export function analyzeGroups(table: DataTable, spec: GroupsSpec): GroupsAnalysis {
  const { grouped, blank, groups: all } = prepared(table, spec);
  const groups = all.filter((g) => g.summary.n > 0);
  const suggested = suggestTest(groups);
  const test = runTest(groups, spec.test, spec.control);
  const warnings: string[] = [];
  const facts: Fact[] = [];
  const caption: string[] = [];
  const thin = groups.filter((g) => g.role !== "blank" && g.summary.n < 3);
  if (spec.test !== "none" && thin.length > 0) {
    const who = thin.length <= 4 ? listOf(thin.map((g) => `${g.label} (n = ${g.summary.n})`)) : `${thin.length} groups`;
    warnings.push(`${who} ${thin.length === 1 ? "has" : "have"} fewer than 3 repeats, so a test can say very little. Read the p-value with care.`);
  }
  const sds = groups.filter((g) => g.summary.sd !== null && g.role !== "blank").map((g) => g.summary.sd ?? 0);
  if (spec.test === "anova" && sds.length >= 3 && Math.min(...sds) > 0 && Math.max(...sds) / Math.min(...sds) > 3) {
    warnings.push(
      `The groups vary by very different amounts (SD from ${formatFit(Math.min(...sds))} to ${formatFit(Math.max(...sds))}), which one-way ANOVA assumes they don't. Comparing each with a control by Welch's t-tests doesn't assume it.`,
    );
  }
  if (spec.test !== "none" && spec.test !== suggested.test) {
    warnings.push(`${TEST_NAMES[spec.test]} is picked by hand. For these groups we'd suggest ${TEST_NAMES[suggested.test].toLowerCase()}: ${suggested.reason}`);
  }
  const missing = groups.reduce((n, g) => n + g.missing, 0);
  if (missing > 0) warnings.push(`${plural(missing, "well or cell", "wells or cells")} in these groups ${missing === 1 ? "has" : "have"} no number and ${missing === 1 ? "is" : "are"} left out.`);

  facts.push({ question: "How many repeats?", answer: nPhrase(groups.filter((g) => g.role !== "blank")), explain: "n: how many separate measurements make up each group. Every one is drawn as a dot when there are 10 or fewer." });
  if (spec.mark === "bar") facts.push({ question: "What do the error bars show?", answer: SPREAD_NAMES[spec.spread], explain: SPREAD_HELP[spec.spread] });
  else facts.push({ question: "How is the box drawn?", answer: "Quartiles by linear interpolation", explain: "The box runs from the 25th to the 75th percentile with a line at the median, worked out as Excel's QUARTILE.INC and NumPy do. Whiskers reach the furthest values within 1.5 box heights; dots past them are outliers." });
  const named = testFacts(test);
  facts.push(...named.facts);
  caption.push(...named.caption);
  if (spec.marks && (test.kind === "welch" || test.kind === "control")) caption.push("* p < 0.05, ** p < 0.01, *** p < 0.001, ns not significant.");
  if (blank !== null) caption.push(blankLine(blank));
  return {
    kind: "groups",
    groups,
    blank,
    measure: grouped.measure,
    test,
    suggested,
    boxes: groups.map((g) => (g.repeats.length === 0 ? null : boxStats(g.repeats.map((r) => r.value)))),
    facts,
    warnings,
    caption,
  };
}

function testFacts(test: TestOutcome): { facts: Fact[]; caption: string[] } {
  switch (test.kind) {
    case "none":
      return { facts: [], caption: [] };
    case "cannot":
      return { facts: [{ question: "Is the difference real?", answer: `${TEST_NAMES[test.test]} can't run`, explain: test.reason }], caption: [`${TEST_NAMES[test.test]}: ${test.reason}`] };
    case "welch": {
      const p = test.result.p;
      return {
        facts: [{ question: "Is the difference real?", answer: `Welch's t-test, ${pEq(p)}`, explain: explainP(p) }],
        caption: [`${test.a.label} vs ${test.b.label}: Welch's t-test, t = ${formatFit(test.result.statistic)}, df = ${formatFit(test.result.df)}, ${pEq(p)}; n = ${test.a.summary.n} and ${test.b.summary.n}.`],
      };
    }
    case "anova": {
      const p = test.result.p;
      return {
        facts: [
          {
            question: "Do the groups differ?",
            answer: `One-way ANOVA, ${pEq(p)}`,
            explain: `One-way ANOVA asks whether any group's mean differs from the others, not which one. ${explainP(p)}`,
          },
        ],
        caption: [`One-way ANOVA, F(${test.result.df}, ${test.result.df2 ?? 0}) = ${formatFit(test.result.statistic)}, ${pEq(p)}; ${nList(test.groups)}.`],
      };
    }
    case "control": {
      const facts = test.comparisons.map((c) => ({
        question: `Is ${c.label} different from ${test.control.label}?`,
        answer: `${pEq(c.adjusted)}, Holm-corrected`,
        explain: `Welch's t-test of ${c.label} against ${test.control.label}, with the p-value raised by Holm's method because ${test.comparisons.length} groups are tested at once (uncorrected ${pEq(c.p)}). ${explainP(c.adjusted)}`,
      }));
      const list = test.comparisons.map((c) => `${c.label} ${pEq(c.adjusted)}`).join("; ");
      return { facts, caption: [`Each group against ${test.control.label}: Welch's t-tests, Holm-corrected. ${list}; n = ${test.comparisons.map((c) => c.n).join(", ")} vs ${test.control.summary.n}.`] };
    }
    default: {
      const _exhaustive: never = test;
      return _exhaustive;
    }
  }
}

// "p = 0.003", or "p < 0.0001".
export function pEq(p: number): string {
  const text = formatP(p);
  return text.startsWith("<") ? `p ${text}` : `p = ${text}`;
}

function nList(groups: readonly GroupStat[]): string {
  const ns = [...new Set(groups.map((g) => g.summary.n))];
  return ns.length === 1 ? `n = ${ns[0]} per group` : `n = ${groups.map((g) => g.summary.n).join(", ")}`;
}

function blankLine(blank: Blank): string {
  return `The blank (mean of ${plural(blank.n, "well")}, ${formatFit(blank.mean)}) is taken off every reading.`;
}

function listOf(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// ---------------------------------------------------------------------------------------------
// A standard curve: means of the standards, a fitted line, and the unknowns read off it.

export type Unknown = {
  label: string;
  n: number;
  reading: number;
  readings: { value: number; where: string }[];
  // In the well as read, then times the dilution, or null without a fitted line.
  conc: number | null;
  dilution: number | null;
  original: number | null;
  outside: "below" | "above" | null;
};

export type CurveAnalysis = {
  kind: "curve";
  standards: GroupStat[];
  blank: Blank | null;
  grouped: Grouped;
  fit: LineFit | null;
  unknowns: Unknown[];
  range: [number, number] | null;
  facts: Fact[];
  warnings: string[];
  caption: string[];
};

export function analyzeCurve(table: DataTable, spec: CurveSpec, tables: readonly DataTable[] = [table]): CurveAnalysis {
  const { grouped, blank, groups } = prepared(table, spec);
  const isStandard = (g: GroupStat) => g.at !== null && g.summary.n > 0 && (spec.source.kind !== "plate" || g.role === "standard");
  const standards = groups.filter(isStandard).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const xs = standards.map((g) => g.at ?? 0);
  const fit = spec.fit === "none" || standards.length < 2 ? null : fitLine(xs, standards.map((g) => g.summary.mean), spec.fit === "origin");
  const range: [number, number] | null = xs.length === 0 ? null : [Math.min(...xs), Math.max(...xs)];
  const unknowns = fit === null ? [] : readUnknowns(spec, groups, blank, tables, fit, range);
  const warnings: string[] = [];
  const facts: Fact[] = [];
  const caption: string[] = [];
  const unit = grouped.key.unit;
  const u = unit ? ` ${unit}` : "";
  if (spec.fit !== "none" && standards.length < 3) warnings.push(`A line through ${plural(standards.length, "point")} can't show whether it really is straight. Use at least 3 standards.`);
  if (fit !== null && fit.slope <= 0) warnings.push("The fitted line doesn't rise, so readings can't be turned into amounts with it.");
  if (fit !== null && fit.r2 < 0.98 && standards.length >= 3) warnings.push(`R² is ${fit.r2.toFixed(3)}, so the points don't sit well on a straight line. Look for a standard that's off, or one past where the assay stays straight.`);
  const outside = unknowns.filter((k) => k.outside !== null);
  for (const k of outside) {
    warnings.push(`${k.label} reads ${k.outside === "above" ? "above your highest" : "below your lowest"} standard, outside your standards, so its number is a guess. ${k.outside === "above" ? "Dilute it more and read it again." : "Use less dilution, or a lower standard."}`);
  }
  if (fit !== null) {
    const eq = equation(fit);
    facts.push({
      question: "The fitted line",
      answer: eq,
      explain: fit.origin
        ? "A straight line forced through zero, fitted to the means of the standards by least squares: a reading of zero means none there."
        : "A straight line fitted to the means of the standards by least squares. Its slope is how much the reading rises per unit along the bottom.",
    });
    facts.push({
      question: "How well does it fit?",
      answer: `R² = ${fit.r2.toFixed(4)}`,
      explain: fit.origin
        ? "R²: how much of the change in the readings the line explains, from 0 to 1. Measured against a flat line at the mean, as with an intercept, so the two fits compare (it reads lower than Excel's through-zero R²)."
        : "R²: how much of the change in the readings the line explains, from 0 to 1. Above 0.98 is what most assays ask of a standard curve.",
    });
    caption.push(`${fit.origin ? "Line through the origin" : "Least-squares line"} fitted to the means of ${plural(standards.length, "standard")}: ${eq}, R² = ${fit.r2.toFixed(4)}.`);
  }
  const per = spec.source.kind === "plate" ? "per standard" : "per point";
  const repeated = standards.some((g) => g.summary.n > 1);
  if (repeated) {
    facts.push({ question: "How many repeats?", answer: nPhrase(standards, per), explain: "n: how many wells or repeats each point's mean is made from." });
    facts.push({ question: "What do the error bars show?", answer: SPREAD_NAMES[spec.spread], explain: SPREAD_HELP[spec.spread] });
  }
  if (unknowns.length > 0) {
    facts.push({
      question: "Your samples",
      answer: `${plural(unknowns.length, "sample")} read off the line${outside.length > 0 ? `, ${outside.length} outside the standards` : ""}`,
      explain: `Each sample's amount is (reading${fit?.origin ? "" : " − intercept"}) ÷ slope, times its dilution. The table under the chart lists them.`,
    });
    caption.push(`Samples read off the line, in${u || " the same units"}${unknowns.some((k) => k.dilution !== null) ? ", times each one's dilution" : ""}.`);
  }
  if (blank !== null) caption.push(blankLine(blank));
  return { kind: "curve", standards, blank, grouped, fit, unknowns, range, facts, warnings, caption };
}

export function equation(fit: LineFit): string {
  const slope = formatFit(fit.slope);
  if (fit.origin) return `y = ${slope}x`;
  const sign = fit.intercept < 0 ? "−" : "+";
  return `y = ${slope}x ${sign} ${formatFit(Math.abs(fit.intercept))}`;
}

function readUnknowns(spec: CurveSpec, groups: readonly GroupStat[], blank: Blank | null, tables: readonly DataTable[], fit: LineFit, range: [number, number] | null): Unknown[] {
  const toConc = (y: number) => (fit.slope === 0 ? null : (y - fit.intercept) / fit.slope);
  const make = (label: string, readings: { value: number; where: string }[], dilution: number | null): Unknown => {
    const reading = readings.reduce((s, r) => s + r.value, 0) / readings.length;
    const conc = toConc(reading);
    const outside = conc === null || range === null ? null : conc < range[0] - 1e-9 * Math.abs(range[0]) ? "below" : conc > range[1] * (1 + 1e-9) ? "above" : null;
    return { label, n: readings.length, reading, readings, conc, dilution, original: conc === null ? null : conc * (dilution ?? 1), outside };
  };
  const u = spec.unknowns;
  if (u === null) return [];
  if (u.kind === "layout") {
    return groups.filter((g) => g.role === "sample" && g.summary.n > 0).map((g) => make(g.label, g.repeats, g.dilution));
  }
  const other = tables.find((t) => t.name === u.table);
  if (other === undefined) return [];
  const label = findColumn(other, u.label);
  const value = findColumn(other, u.value);
  const dilution = u.dilution === null ? undefined : findColumn(other, u.dilution);
  if (label === undefined || value?.kind !== "number") return [];
  const out: Unknown[] = [];
  for (let r = 0; r < other.rows; r++) {
    const v = value.values[r];
    const name = label.values[r];
    if (v === null || v === undefined || name === null || name === undefined) continue;
    const d = dilution?.kind === "number" ? (dilution.values[r] ?? null) : null;
    out.push(make(String(typeof name === "number" ? formatValue(name) : name), [{ value: v - (blank?.mean ?? 0), where: `${value.name} row ${r + 1}` }], d !== null && d > 0 ? d : null));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// A line through the means over time or another number, with the spread as a band.

export type BandSeries = { name: string; groups: GroupStat[] };
export type BandAnalysis = { kind: "band"; series: BandSeries[]; blank: Blank | null; grouped: Grouped; facts: Fact[]; warnings: string[]; caption: string[] };

export function analyzeBand(table: DataTable, spec: BandSpec): BandAnalysis {
  const { grouped, blank, groups } = prepared(table, spec);
  const names = [...new Set(groups.filter((g) => g.role !== "blank" && g.at !== null).map((g) => g.series))];
  const series = names.map((name) => ({ name: name || grouped.measure.name || "Mean", groups: groups.filter((g) => g.series === name && g.at !== null && g.summary.n > 0 && g.role !== "blank").sort((a, b) => (a.at ?? 0) - (b.at ?? 0)) }));
  const all = series.flatMap((s) => s.groups);
  const facts: Fact[] = [];
  const warnings: string[] = [];
  if (all.length > 0) facts.push({ question: "How many repeats?", answer: nPhrase(all, "at each point"), explain: "n: how many repeats each point's mean is made from." });
  facts.push({ question: spec.band ? "What does the shading show?" : "What do the error bars show?", answer: SPREAD_NAMES[spec.spread], explain: SPREAD_HELP[spec.spread] });
  if (all.some((g) => g.summary.n < 2)) warnings.push("Some points have a single repeat, so the spread there can't be shown.");
  const caption = [`Lines join the means; ${spec.band ? "the shading" : "error bars"} show${spec.band ? "s" : ""} ${SPREAD_NAMES[spec.spread]}, ${nPhrase(all, "at each point")}.`];
  if (blank !== null) caption.push(blankLine(blank));
  return { kind: "band", series, blank, grouped, facts, warnings, caption };
}

// ---------------------------------------------------------------------------------------------
// A dose-response curve.

export type DoseVerdict =
  | { kind: "ok"; mid: number; ci: [number, number] }
  | { kind: "unsure"; mid: number | null; ci: [number, number] | null; reason: string }
  | { kind: "none"; reason: string };

export type DoseSeries = {
  name: string;
  doses: GroupStat[];
  control: GroupStat | null;
  fit: DoseFit;
  verdict: DoseVerdict;
  // IC50 when the curve falls with the dose, EC50 when it rises.
  term: "IC50" | "EC50";
  params: FourPL | null;
};

export type DoseAnalysis = { kind: "dose"; series: DoseSeries[]; blank: Blank | null; grouped: Grouped; unit: string; facts: Fact[]; warnings: string[]; caption: string[] };

const TERM_HELP = {
  IC50: "IC50: the concentration that gives half the full effect, halfway between the curve's top and bottom.",
  EC50: "EC50: the concentration that gives half the full effect, halfway between the curve's bottom and top.",
} as const;

export function analyzeDose(table: DataTable, spec: DoseSpec): DoseAnalysis {
  const { grouped, blank, groups } = prepared(table, spec);
  const unit = spec.x.unit || grouped.key.unit;
  const u = unit ? ` ${unit}` : "";
  const live = groups.filter((g) => g.role !== "blank" && g.summary.n > 0);
  const controls = live.filter((g) => g.role === "control" || g.at === 0);
  const names = [...new Set(live.filter((g) => g.at !== null && g.at > 0 && g.role !== "control").map((g) => g.series))];
  const facts: Fact[] = [];
  const warnings: string[] = [];
  const caption: string[] = [];
  const series = names.map((name): DoseSeries => {
    const doses = live.filter((g) => g.series === name && g.at !== null && g.at > 0 && g.role !== "control").sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const control = controls.find((g) => g.series === name) ?? controls[0] ?? null;
    const points = spec.fit === "means" ? doses.map((g) => ({ x: Math.log10(g.at ?? 1), y: g.summary.mean })) : doses.flatMap((g) => g.repeats.map((r) => ({ x: Math.log10(g.at ?? 1), y: r.value })));
    const fit = fitDose(
      points.map((p) => p.x),
      points.map((p) => p.y),
    );
    const label = name || grouped.measure.name || "The response";
    const term = fit.kind === "fit" && fit.rising ? "EC50" : "IC50";
    const lo = doses[0]?.at ?? 0;
    const hi = doses.at(-1)?.at ?? 0;
    const tested = `${formatValue(lo)} to ${formatValue(hi)}${u}`;
    return { name: label, doses, control, fit, verdict: verdictOf(fit, label, term, [lo, hi], tested, u), term, params: fit.kind === "fit" ? fit.params : null };
  });
  for (const s of series) {
    const v = s.verdict;
    const who = series.length > 1 ? `${s.name}: ` : "";
    if (v.kind === "ok") {
      facts.push({ question: `${who}Where is the halfway point?`, answer: `${s.term} ${formatFit(v.mid)}${u} (${formatFit(v.ci[0])} to ${formatFit(v.ci[1])})`, explain: `${TERM_HELP[s.term]} The range in brackets is its 95% confidence interval.` });
    } else if (v.kind === "unsure") {
      facts.push({ question: `${who}Where is the halfway point?`, answer: v.mid === null ? `${s.term} not measured` : `${s.term} about ${formatFit(v.mid)}${u}, not pinned down`, explain: `${TERM_HELP[s.term]} ${v.reason}` });
      warnings.push(`${who}${v.reason}`);
    } else {
      facts.push({ question: `${who}Where is the halfway point?`, answer: `No ${s.term}`, explain: v.reason });
      warnings.push(`${who}${v.reason}`);
    }
    if (s.params !== null && v.kind !== "none") {
      facts.push({
        question: `${who}Where does it level off?`,
        answer: `Top ${formatFit(s.params.top)}, bottom ${formatFit(s.params.bottom)}`,
        explain: "Top and bottom: the two levels the fitted curve flattens out at, at the lowest and highest doses.",
      });
      facts.push({
        question: `${who}How steep is it?`,
        answer: `Hill slope ${formatFit(s.params.hill)}`,
        explain: "Hill slope: how steeply the curve turns. About 1 (or −1 for a falling curve) is typical of one drug binding one site; bigger means a sharper switch.",
      });
    }
    if (s.doses.some((g) => g.summary.n < 2)) warnings.push(`${who}Some doses have a single well, so the curve rests on few points.`);
    if (s.verdict.kind === "ok" || s.verdict.kind === "unsure") {
      const p = s.params;
      const what = s.verdict.kind === "ok" ? `${s.term} ${formatFit(s.verdict.mid)}${u} (95% CI ${formatFit(s.verdict.ci[0])} to ${formatFit(s.verdict.ci[1])})` : `${s.term} not pinned down`;
      caption.push(`${series.length > 1 ? `${s.name}: ` : ""}four-parameter logistic fit to ${spec.fit === "means" ? "the means" : "every well"} on log dose; ${what}${p === null ? "" : `, top ${formatFit(p.top)}, bottom ${formatFit(p.bottom)}, Hill slope ${formatFit(p.hill)}`}.`);
    }
  }
  const doses = series.flatMap((s) => s.doses);
  if (doses.length > 0) facts.push({ question: "How many repeats?", answer: nPhrase(doses, "per dose"), explain: `n: how many wells each dose's mean is made from. The curve is fitted to ${spec.fit === "means" ? "the means" : "every well, so it counts each repeat"}.` });
  facts.push({ question: "What do the error bars show?", answer: SPREAD_NAMES[spec.spread], explain: SPREAD_HELP[spec.spread] });
  if (controls.length > 0) caption.push(`${controls.map((c) => c.label).join(", ")} (no drug) is drawn as a dashed line, since zero has no place on a log scale.`);
  caption.push(`Error bars show ${SPREAD_NAMES[spec.spread]}, ${doses.length === 0 ? "" : nPhrase(doses, "per dose")}.`);
  if (blank !== null) caption.push(blankLine(blank));
  if (series.length === 0) warnings.push("No doses above zero to draw. Mark the wells' concentrations in the layout.");
  return { kind: "dose", series, blank, grouped, unit, facts, warnings, caption };
}

function verdictOf(fit: DoseFit, name: string, term: "IC50" | "EC50", range: [number, number], tested: string, u: string): DoseVerdict {
  switch (fit.kind) {
    case "too-few":
      return { kind: "none", reason: `A four-parameter curve needs at least 5 concentrations, and ${name} has ${fit.doses}, so there's no ${term} to give.` };
    case "no-fit":
      return { kind: "none", reason: `The curve couldn't be fitted to ${name}'s numbers, so there's no ${term}. Check the wells for a mistake in the layout.` };
    case "flat":
      return { kind: "none", reason: `${name}'s effect hardly changes with the dose (a curve fits no better than a flat line, p = ${formatP(fit.p)}), so there's no ${term} to give.` };
    case "step":
      return {
        kind: "none",
        reason: `The effect jumps between ${formatValue(10 ** fit.between[0])} and ${formatValue(10 ** fit.between[1])}${u} with no dose in between, so the slope and the ${term} can't be measured. Add doses between them.`,
      };
    case "fit": {
      const mid = 10 ** fit.params.logMid;
      const [lo, hi] = range;
      if (mid < lo || mid > hi) {
        return { kind: "unsure", mid: null, ci: null, reason: `The halfway point falls ${mid < lo ? "below" : "above"} the doses you tested (${tested}), so the ${term} isn't measured. Test ${mid < lo ? "lower" : "higher"} doses.` };
      }
      if (fit.logMidCi === null) return { kind: "unsure", mid, ci: null, reason: `The fit can't say how sure the ${term} is.` };
      const ci: [number, number] = [10 ** fit.logMidCi[0], 10 ** fit.logMidCi[1]];
      if (ci[0] < lo || ci[1] > hi) {
        return {
          kind: "unsure",
          mid,
          ci,
          reason: `Its 95% range runs from ${formatFit(ci[0])} to ${formatFit(ci[1])}${u}, past the doses you tested (${tested}), so the ${term} isn't pinned down. More doses around it would help.`,
        };
      }
      return { kind: "ok", mid, ci };
    }
    default: {
      const _exhaustive: never = fit;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// A histogram.

export type HistogramAnalysis = {
  kind: "histogram";
  values: number[];
  width: number;
  edges: number[];
  counts: number[];
  rule: string;
  facts: Fact[];
  warnings: string[];
  caption: string[];
};

const MAX_BINS = 200;

export function analyzeHistogram(table: DataTable, spec: HistogramSpec): HistogramAnalysis {
  const column = findColumn(table, spec.column);
  const values = column?.kind === "number" ? column.values.filter((v): v is number => v !== null) : [];
  const unit = spec.x.unit ? ` ${spec.x.unit}` : "";
  const warnings: string[] = [];
  if (values.length === 0) return { kind: "histogram", values, width: 1, edges: [], counts: [], rule: "", facts: [], warnings: ["There are no numbers to count."], caption: [] };
  const raw = rawBinWidth(values);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  let width = spec.bin ?? roundWidth(raw.width);
  if ((hi - lo) / width > MAX_BINS) {
    width = roundWidth((hi - lo) / MAX_BINS) * 2;
    warnings.push(`That bin width would make more than ${MAX_BINS} bins, so they're ${formatValue(width)}${unit} wide.`);
  }
  const edges = binEdges(values, width);
  const counts = binCounts(values, edges);
  const rule =
    spec.bin === null
      ? `Bins ${formatValue(width)}${unit} wide, from the ${raw.rule} rule (${raw.rule === "Freedman–Diaconis" ? "2 × IQR ÷ ∛n" : "range ÷ (log₂ n + 1)"} = ${formatFit(raw.width)}), rounded to a round number.`
      : `Bins ${formatValue(width)}${unit} wide, set by hand.`;
  const sorted = [...values].sort((a, b) => a - b);
  const facts: Fact[] = [
    { question: "How many values?", answer: `n = ${values.length.toLocaleString("en-US")}`, explain: "n: how many values the bars count, every number in the column." },
    {
      question: "Where's the middle?",
      answer: `Median ${formatFit(quantile(sorted, 0.5))}${unit}, middle half ${formatFit(quantile(sorted, 0.25))} to ${formatFit(quantile(sorted, 0.75))}`,
      explain: "Half the values are below the median and half above. The middle half runs from the 25th to the 75th percentile (by linear interpolation, as Excel's QUARTILE.INC).",
    },
    { question: "How wide is each bar?", answer: `${formatValue(width)}${unit}`, explain: rule },
  ];
  if (values.length < 20) warnings.push(`With ${values.length} values a histogram's shape is mostly chance. A box plot or the dots themselves may say more.`);
  const invalid = column?.invalid ?? 0;
  if (invalid > 0) warnings.push(`${plural(invalid, "cell")} in ${column?.name ?? "the column"} ${invalid === 1 ? "isn't a number" : "aren't numbers"} and ${invalid === 1 ? "is" : "are"} left out.`);
  return { kind: "histogram", values, width, edges, counts, rule, facts, warnings, caption: [`${values.length.toLocaleString("en-US")} values. ${rule}`] };
}

export type Analysis = GroupsAnalysis | CurveAnalysis | BandAnalysis | DoseAnalysis | HistogramAnalysis;

export function analyze(table: DataTable, spec: SummarySpec | HistogramSpec, tables: readonly DataTable[] = [table]): Analysis {
  switch (spec.type) {
    case "groups":
      return analyzeGroups(table, spec);
    case "curve":
      return analyzeCurve(table, spec, tables);
    case "band":
      return analyzeBand(table, spec);
    case "dose":
      return analyzeDose(table, spec);
    case "histogram":
      return analyzeHistogram(table, spec);
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}
