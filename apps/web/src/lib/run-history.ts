import { z } from "zod";
import { linearScale, niceDomain, textWidth, TICK_FONT, TITLE_FONT, LABEL_FONT, type Tick } from "./chart-geometry";
import { CheckRange, CheckSpec, CheckSpecs, formatNumber, measureText, rangeText, type CheckSpec as Check } from "./checks";
import { formatDate } from "./data-tables";
import { CheckId, FlagId, ProtocolId, Sha256 } from "./ids";
import { RunInfo, isFailed, runName } from "./runs";

// A protocol check's results across runs (decisions.md, "charts round 2"): each file the check
// ran on is one run, its value is a point, the range it was held to is a shaded band behind it,
// a flagged value is amber and a run labeled failed is a gray ring, drawn and never left out.
// The worker keeps one result per file and check (check_results, 0018), stamped with the
// protocol version, whose range the run was checked against.

export const RESULTS = ["passed", "flagged", "couldnt"] as const;

export const HistoryRun = z.object({
  run: RunInfo,
  observed: z.number().nullable(),
  result: z.enum(RESULTS),
  reason: z.string().nullable(),
  range: CheckRange,
  unit: z.string().nullable(),
  version: z.number().int().positive(),
  flagId: FlagId.nullable(),
});
export type HistoryRun = z.infer<typeof HistoryRun>;

export type RunHistory = {
  protocol: { id: ProtocolId; title: string };
  check: Check;
  // The checks of the protocol's current version, for picking another.
  checks: { id: CheckId; name: string }[];
  runs: HistoryRun[];
};

export const RunHistoryWire = z.object({
  protocol: z.object({ id: ProtocolId, title: z.string() }),
  check: CheckSpec,
  checks: z.array(z.object({ id: CheckId, name: z.string() })),
  runs: z.array(HistoryRun),
}) satisfies z.ZodType<RunHistory>;

// The rows a history is read from: the worker's results for the check, the versions they cite,
// and the open flags that link a flagged run to its page.
export const HISTORY_RESULT_COLUMNS = "sha256, protocol_version_id, outcome, observed, unit, reason";
export const ResultRows = z.array(
  z.object({ sha256: Sha256, protocol_version_id: z.string(), outcome: z.enum(RESULTS), observed: z.number().nullable(), unit: z.string().nullable(), reason: z.string().nullable() }),
);
export const VersionRows = z.array(z.object({ id: z.string(), version: z.number().int().positive(), expected_values: CheckSpecs }));
export const OpenFlagRows = z.array(z.object({ id: FlagId, sha256: Sha256 }));

// The history from those rows: each result with the range of the version it was checked
// against, oldest run first. Null when no version has the check. A result whose file is gone
// from the lab, or whose version no longer holds the check, is left out.
export function assembleHistory(input: {
  protocol: { id: ProtocolId; title: string };
  current: readonly Check[];
  checkId: CheckId;
  results: z.infer<typeof ResultRows>;
  versions: z.infer<typeof VersionRows>;
  runs: readonly RunInfo[];
  flags: z.infer<typeof OpenFlagRows>;
}): RunHistory | null {
  const { checkId, current, versions } = input;
  const held = new Map(versions.map((v) => [v.id, { version: v.version, check: v.expected_values.find((c) => c.id === checkId) }]));
  const check = current.find((c) => c.id === checkId) ?? [...versions].sort((a, b) => b.version - a.version).flatMap((v) => v.expected_values.filter((c) => c.id === checkId))[0];
  if (check === undefined) return null;
  const runOf = new Map(input.runs.map((r) => [r.sha256, r]));
  const flagOf = new Map(input.flags.map((f) => [f.sha256, f.id]));
  const runs = input.results.flatMap((r): HistoryRun[] => {
    const run = runOf.get(r.sha256);
    const by = held.get(r.protocol_version_id);
    if (run === undefined || by?.check === undefined) return [];
    return [{ run, observed: r.observed, result: r.outcome, reason: r.reason, range: by.check.range, unit: r.unit ?? by.check.unit, version: by.version, flagId: flagOf.get(r.sha256) ?? null }];
  });
  return {
    protocol: input.protocol,
    check,
    checks: (current.length > 0 ? current : [check]).map((c) => ({ id: c.id, name: c.name })),
    runs: runs.sort(historyOrder),
  };
}

export function historyHref(protocolId: ProtocolId, checkId: CheckId): string {
  return `/protocols/${protocolId}/runs?${new URLSearchParams({ check: checkId })}`;
}

// Oldest run first: by the day its label gives, then its name.
export function historyOrder(a: HistoryRun, b: HistoryRun): number {
  return (a.run.date ?? "").localeCompare(b.run.date ?? "") || runName(a.run).localeCompare(runName(b.run));
}

// The range as numbers a band can be drawn between; an open end runs to the edge.
export function rangeBounds(range: CheckRange): { lo: number | null; hi: number | null } {
  switch (range.kind) {
    case "at_least":
      return { lo: range.min, hi: null };
    case "at_most":
      return { lo: null, hi: range.max };
    case "between":
      return { lo: range.min, hi: range.max };
    case "around":
      return { lo: range.target - range.tolerance, hi: range.target + range.tolerance };
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

export function runDay(run: RunInfo): string | null {
  return run.date === null ? null : formatDate(Date.parse(`${run.date.slice(0, 10)}T00:00:00Z`), false);
}

export type HistoryPoint = { index: number; px: number; py: number; flagged: boolean; failed: boolean };

export type HistoryPlot = {
  width: number;
  height: number;
  area: { left: number; top: number; width: number; height: number };
  title: { text: string; x: number; y: number } | null;
  yTicks: Tick[];
  xTicks: { pos: number; label: string }[];
  yTitle: { text: string; x: number; y: number };
  xTitle: { text: string; x: number; y: number };
  // The allowed range behind the runs, one rectangle per stretch of runs held to the same range.
  band: string;
  // The runs that weren't failed, joined in order.
  line: string;
  points: HistoryPoint[];
  legend: { kind: "in" | "flagged" | "failed" | "band"; text: string; x: number; y: number }[];
  // Each run's middle along x, for the hover layer, in order.
  stops: number[];
  notes: string[];
};

const LEGEND_ITEMS = { in: "In range", flagged: "Flagged", failed: "Failed run", band: "Allowed range" } as const;
const LEGEND_KINDS = ["band", "in", "flagged", "failed"] as const;

export function plotHistory(history: RunHistory, size: { width: number; height: number }, options: { title?: string } = {}): HistoryPlot {
  const runs = history.runs;
  const unit = history.check.unit;
  const values = runs.flatMap((r) => (r.observed === null ? [] : [r.observed]));
  const edges = runs.flatMap((r) => {
    const { lo, hi } = rangeBounds(r.range);
    return [lo, hi].filter((v): v is number => v !== null);
  });
  const all = [...values, ...edges];
  const lo = all.length === 0 ? 0 : Math.min(...all);
  const hi = all.length === 0 ? 1 : Math.max(...all);
  const pad = lo === hi ? Math.max(1, Math.abs(lo) * 0.1) : (hi - lo) * 0.08;
  const [yLo, yHi] = niceDomain(lo - pad, hi + pad, 5);

  const title = options.title ? { text: options.title, x: 0, y: TITLE_FONT + 4 } : null;
  const yLabels = 5;
  const tickWidth = Math.max(...[yLo, yHi].map((v) => textWidth(formatNumber(v), TICK_FONT)));
  const left = Math.ceil(tickWidth + 12 + LABEL_FONT + 10);

  // The key above the plot, wrapping onto a second line on a narrow screen.
  const checked = runs.filter((r) => r.observed !== null);
  const shown: Record<keyof typeof LEGEND_ITEMS, boolean> = {
    band: true,
    in: checked.some((r) => r.result !== "flagged" && !isFailed(r.run)),
    flagged: checked.some((r) => r.result === "flagged"),
    failed: checked.some((r) => isFailed(r.run)),
  };
  const legendTop = (title ? TITLE_FONT + 16 : 0) + 16;
  let lx = left;
  let ly = legendTop;
  const legend = LEGEND_KINDS.filter((k) => shown[k]).map((kind) => {
    const w = 22 + textWidth(LEGEND_ITEMS[kind], TICK_FONT) + 16;
    if (lx + w > size.width && lx > left) {
      lx = left;
      ly += 20;
    }
    const item = { kind, text: LEGEND_ITEMS[kind], x: lx, y: ly };
    lx += w;
    return item;
  });
  const top = ly + 18;
  const bottom = TICK_FONT + 8 + LABEL_FONT + 14;
  const area = { left, top, width: Math.max(40, size.width - left - 12), height: Math.max(80, size.height - top - bottom) };
  const y = linearScale(yLo, yHi, area.top + area.height, area.top, yLabels);
  const step = area.width / Math.max(1, runs.length);
  const xOf = (i: number) => area.left + step * (i + 0.5);

  // Neighbouring runs held to the same range share one rectangle.
  const rects: string[] = [];
  let start = 0;
  const clampY = (v: number) => Math.min(area.top + area.height, Math.max(area.top, v));
  for (let i = 1; i <= runs.length; i++) {
    if (i < runs.length && JSON.stringify(runs[i]?.range) === JSON.stringify(runs[start]?.range)) continue;
    const r = runs[start];
    if (r !== undefined) {
      const b = rangeBounds(r.range);
      const yTop = b.hi === null ? area.top : clampY(y.map(b.hi));
      const yBottom = b.lo === null ? area.top + area.height : clampY(y.map(b.lo));
      const x0 = area.left + step * start;
      const x1 = area.left + step * i;
      if (yBottom > yTop) rects.push(`M${r1(x0)} ${r1(yTop)}H${r1(x1)}V${r1(yBottom)}H${r1(x0)}Z`);
    }
    start = i;
  }

  const points: HistoryPoint[] = runs.flatMap((r, index) =>
    r.observed === null ? [] : [{ index, px: r1(xOf(index)), py: r1(y.map(r.observed)), flagged: r.result === "flagged", failed: isFailed(r.run) }],
  );
  const line = points
    .filter((p) => !p.failed)
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.px} ${p.py}`)
    .join("");

  // A date under each run while they fit, thinned to every second, third… when they don't.
  const labels = runs.map((r, i) => runDay(r.run) ?? `Run ${i + 1}`);
  const widest = Math.max(1, ...labels.map((l) => textWidth(l, TICK_FONT)));
  const every = Math.max(1, Math.ceil((widest + 10) / step));
  const xTicks = labels.flatMap((label, i) => (i % every === 0 ? [{ pos: r1(xOf(i)), label }] : []));


  const notes: string[] = [];
  const couldnt = runs.filter((r) => r.observed === null);
  if (couldnt.length > 0) notes.push(`${couldnt.length === 1 ? "1 run" : `${couldnt.length} runs`} couldn't be checked, so ${couldnt.length === 1 ? "it has" : "they have"} no point: ${couldnt.map((r) => `${runName(r.run)} (${(r.reason ?? "no reason given").replace(/\.$/, "")})`).join("; ")}.`);
  const versions = [...new Set(runs.map((r) => r.version))];
  const sorted = versions.sort((a, b) => a - b);
  if (sorted.length > 1) notes.push(`Runs were checked under versions ${sorted.slice(0, -1).join(", ")} and ${sorted.at(-1)}; each run's band is the range of the version it was checked against.`);

  return {
    width: size.width,
    height: size.height,
    area,
    title,
    yTicks: y.ticks,
    xTicks,
    yTitle: { text: unit === null ? measureText(history.check) : `${measureText(history.check)} (${unit})`, x: LABEL_FONT, y: area.top + area.height / 2 },
    xTitle: { text: "Runs, oldest first", x: area.left + area.width / 2, y: area.top + area.height + TICK_FONT + 8 + LABEL_FONT + 6 },
    band: rects.join(""),
    line,
    points,
    legend,
    stops: runs.map((_, i) => r1(xOf(i))),
    notes,
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

// The sentence under the title: what each point is, what the band is, and what stands out.
export function describeHistory(history: RunHistory): string {
  const runs = history.runs;
  if (runs.length === 0) return `${history.check.name} hasn't been checked on any run yet. Each data file tied to ${history.protocol.title} adds a point as it's checked.`;
  const checked = runs.filter((r) => r.observed !== null);
  const flagged = checked.filter((r) => r.result === "flagged").length;
  const failed = runs.filter((r) => isFailed(r.run)).length;
  const current = runs.at(-1)?.range ?? history.check.range;
  const first = `${history.check.name} for each of the ${runs.length === 1 ? "1 run" : `${runs.length} runs`} of ${history.protocol.title} checked so far, oldest on the left.`;
  const band = ` The shaded band is the allowed range (${rangeText(current, history.check.unit)}${new Set(runs.map((r) => JSON.stringify(r.range))).size > 1 ? " now; it changed over time" : ""}).`;
  const out = flagged === 0 ? " Every checked run fell inside it." : ` ${flagged === 1 ? "1 run fell" : `${flagged} runs fell`} outside it and ${flagged === 1 ? "is" : "are"} amber.`;
  const gray = failed === 0 ? "" : ` ${failed === 1 ? "1 run is" : `${failed} runs are`} labeled failed and drawn as a gray ring, not left out.`;
  return `${first}${band}${out}${gray}`;
}

// The numbers behind it, one row per run, unrounded.
export function historyRows(history: RunHistory): (string | number | null)[][] {
  return history.runs.map((r) => [runName(r.run), r.run.date, r.run.outcome, r.observed, r.unit, rangeText(r.range, r.unit), r.result === "couldnt" ? "couldn't check" : r.result, r.reason, r.version]);
}

export const HISTORY_COLUMNS = ["Run", "Date", "Outcome", "Value", "Unit", "Allowed range", "Result", "Why not checked", "Protocol version"];
