import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { anova, binCounts, binEdges, boxStats, fitDose, fitLine, fourPL, holm, rawBinWidth, roundWidth, summarize, tQuantile, welch } from "../stats";

// Every statistic against SciPy and NumPy (workers/scripts/make_stats_reference.py). Relative
// tolerance 1e-9 for closed forms, 1e-6 for the 4PL's parameters, whose minimum both
// optimizers reach to about that.

const N = z.number();
const Ref = z.object({
  summaries: z.array(z.object({ name: z.string(), values: z.array(N.nullable()), n: N, mean: N, sd: N.optional(), sem: N.optional(), ci: N.optional() })),
  welch: z.array(z.object({ name: z.string(), a: z.array(N), b: z.array(N), t: N, df: N, p: N })),
  anova: z.array(z.object({ name: z.string(), groups: z.array(z.array(N)), f: N, df1: N, df2: N, p: N })),
  vsControl: z.array(z.object({ name: z.string(), control: z.array(N), others: z.array(z.array(N)), raw: z.array(N), holm: z.array(N) })),
  holm: z.array(z.object({ p: z.array(N), adjusted: z.array(N) })),
  lines: z.array(z.object({ name: z.string(), x: z.array(N), y: z.array(N), slope: N, intercept: N, r2: N, originSlope: N, originR2: N })),
  doses: z.array(
    z.object({
      name: z.string(),
      conc: z.array(N),
      y: z.array(N),
      fits: z.boolean(),
      bottom: N.optional(),
      top: N.optional(),
      logMid: N.optional(),
      hill: N.optional(),
      seLogMid: N.optional(),
      ciLogLo: N.optional(),
      ciLogHi: N.optional(),
      ssr: N.optional(),
      flatP: N.optional(),
    }),
  ),
  boxes: z.array(z.object({ name: z.string(), values: z.array(N), q1: N, median: N, q3: N })),
  histograms: z.array(z.object({ name: z.string(), values: z.array(N), fdWidth: N, width: N, edges: z.array(N), counts: z.array(N) })),
  quantiles: z.array(z.object({ p: N, df: N, t: N })),
});
const ref = Ref.parse(JSON.parse(readFileSync(join(__dirname, "stats-reference.json"), "utf8")));

function close(actual: number | null | undefined, expected: number | undefined, rel = 1e-9) {
  expect(actual).not.toBeNull();
  expect(expected).toBeDefined();
  const a = actual ?? Number.NaN;
  const e = expected ?? Number.NaN;
  expect(Math.abs(a - e)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(e)));
}

describe("summaries of repeats", () => {
  for (const c of ref.summaries) {
    it(`${c.name}: mean, SD, SEM and the t-based 95% CI`, () => {
      const s = summarize(c.values.filter((v): v is number => v !== null));
      expect(s.n).toBe(c.n);
      close(s.mean, c.mean);
      if (c.sd === undefined) {
        expect(s.sd).toBeNull();
        expect(s.ci).toBeNull();
      } else {
        close(s.sd, c.sd);
        close(s.sem, c.sem);
        close(s.ci, c.ci);
      }
    });
  }
  it("t quantiles match scipy.stats.t.ppf", () => {
    for (const q of ref.quantiles) close(tQuantile(q.p, q.df), q.t, 1e-10);
  });
});

describe("tests", () => {
  for (const c of ref.welch) {
    it(`Welch's t: ${c.name}`, () => {
      const r = welch(c.a, c.b);
      if (r.kind !== "ok") throw new Error(r.reason);
      close(r.statistic, c.t);
      close(r.df, c.df);
      close(r.p, c.p, 1e-9);
    });
  }
  for (const c of ref.anova) {
    it(`one-way ANOVA: ${c.name}`, () => {
      const r = anova(c.groups);
      if (r.kind !== "ok") throw new Error(r.reason);
      close(r.statistic, c.f);
      expect([r.df, r.df2]).toEqual([c.df1, c.df2]);
      close(r.p, c.p, 1e-9);
    });
  }
  for (const c of ref.vsControl) {
    it(`each group against the control, Holm-corrected: ${c.name}`, () => {
      const raw = c.others.map((o) => {
        const r = welch(o, c.control);
        if (r.kind !== "ok") throw new Error(r.reason);
        return r.p;
      });
      raw.forEach((p, i) => close(p, c.raw[i]));
      holm(raw).forEach((p, i) => close(p, c.holm[i]));
    });
  }
  it("Holm's adjustment", () => {
    for (const c of ref.holm) holm(c.p).forEach((p, i) => close(p, c.adjusted[i], 1e-12));
  });
  it("says why a test can't run instead of giving a number", () => {
    expect(welch([1], [2, 3]).kind).toBe("undefined");
    expect(welch([2, 2], [2, 2]).kind).toBe("undefined");
    expect(anova([[1, 1], [2, 2]]).kind).toBe("undefined");
  });
});

describe("straight lines", () => {
  for (const c of ref.lines) {
    it(`${c.name}: with an intercept (linregress) and through the origin`, () => {
      const free = fitLine(c.x, c.y);
      close(free?.slope, c.slope);
      close(free?.intercept, c.intercept);
      close(free?.r2, c.r2);
      const origin = fitLine(c.x, c.y, true);
      close(origin?.slope, c.originSlope);
      expect(origin?.intercept).toBe(0);
      close(origin?.r2, c.originR2);
    });
  }
  it("has no line when x doesn't vary", () => {
    expect(fitLine([2, 2, 2], [1, 2, 3])).toBeNull();
  });
});

describe("the four-parameter dose-response curve", () => {
  for (const c of ref.doses) {
    const logs = c.conc.map(Math.log10);
    it(`${c.name}`, () => {
      const fit = fitDose(logs, c.y);
      if (c.name === "flat") {
        expect(fit.kind).toBe("flat");
        if (fit.kind === "flat") close(fit.p, c.flatP, 1e-3);
        return;
      }
      if (!c.fits) {
        expect(fit).toEqual({ kind: "step", between: [2, 3] });
        return;
      }
      if (fit.kind !== "fit") throw new Error(`expected a fit, got ${fit.kind}`);
      // Never a worse minimum than curve_fit's.
      expect(fit.ssr).toBeLessThanOrEqual((c.ssr ?? 0) * (1 + 1e-9) + 1e-15);
      const wellPosed = Math.abs(c.seLogMid ?? Infinity) < 1;
      if (!wellPosed) return;
      close(fit.params.bottom, c.bottom, 1e-6);
      close(fit.params.top, c.top, 1e-6);
      close(fit.params.logMid, c.logMid, 1e-6);
      close(fit.params.hill, c.hill, 1e-6);
      close(fit.se?.logMid, c.seLogMid, 1e-5);
      close(fit.logMidCi?.[0], c.ciLogLo, 1e-6);
      close(fit.logMidCi?.[1], c.ciLogHi, 1e-6);
      close(fit.flatP, c.flatP, 1e-6);
    });
  }
  it("needs five concentrations", () => {
    expect(fitDose([0, 1, 2, 3], [1, 0.8, 0.3, 0.1])).toEqual({ kind: "too-few", doses: 4 });
  });
  it("draws the fitted curve through its midpoint at half the span", () => {
    const p = { bottom: 0, top: 1, logMid: 0.5, hill: -1 };
    expect(fourPL(p, 0.5)).toBeCloseTo(0.5, 12);
    expect(fourPL(p, -10)).toBeCloseTo(1, 9);
  });
});

describe("box plots and histograms", () => {
  for (const c of ref.boxes) {
    it(`quartiles match numpy.percentile's default: ${c.name}`, () => {
      const b = boxStats(c.values);
      close(b.q1, c.q1, 1e-12);
      close(b.median, c.median, 1e-12);
      close(b.q3, c.q3, 1e-12);
    });
  }
  it("whiskers stop at the furthest value within 1.5 box heights; the rest are outliers", () => {
    const b = boxStats([3.1, 4.7, 2.2, 5.9, 4.4, 3.8, 9.6, 4.0]);
    expect(b.outliers).toEqual([9.6]);
    expect(b.high).toBe(5.9);
    expect(b.low).toBe(2.2);
  });
  for (const c of ref.histograms) {
    it(`bins: ${c.name}`, () => {
      expect(rawBinWidth(c.values).rule).toBe("Freedman–Diaconis");
      close(rawBinWidth(c.values).width, c.fdWidth, 1e-9);
      const edges = binEdges(c.values, c.width);
      expect(edges).toEqual(c.edges);
      expect(binCounts(c.values, edges)).toEqual(c.counts);
    });
  }
  it("rounds a bin width to 1, 2 or 5 times a power of ten", () => {
    expect([0.73, 1.4, 1.6, 3.4, 3.6, 8, 0.024].map(roundWidth)).toEqual([0.5, 1, 2, 2, 5, 10, 0.02]);
  });
});
