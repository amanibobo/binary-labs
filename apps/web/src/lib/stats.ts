// The statistics behind the charts (decisions.md, "charts round 1"). Plain arithmetic, no
// model and no randomness, so a chart gives the same numbers every time it's drawn. Each
// function is tested against SciPy and NumPy (workers/scripts/make_stats_reference.py writes
// the reference values; lib/__tests__/stats.test.ts compares).

export function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// The sample variance, dividing by n − 1, as Excel's VAR.S and NumPy's var(ddof=1).
export function variance(xs: readonly number[]): number {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}

export const sd = (xs: readonly number[]): number => Math.sqrt(variance(xs));
export const sem = (xs: readonly number[]): number => sd(xs) / Math.sqrt(xs.length);

// ln Γ(x) for x > 0, by Lanczos (g = 7, 9 terms): about 15 digits.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// The continued fraction for the incomplete beta function, by Lentz's method.
function betaFraction(x: number, a: number, b: number): number {
  const TINY = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-16) break;
  }
  return h;
}

// The regularized incomplete beta function I_x(a, b).
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(x, a, b)) / a : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

// The chance of a t at least this far from zero either way, with df degrees of freedom.
export function tTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

// The chance of an F at least this big.
export function fUpperTail(f: number, d1: number, d2: number): number {
  if (f <= 0) return 1;
  if (!Number.isFinite(f)) return 0;
  return incompleteBeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
}

// The t below which a fraction p of the t distribution lies (SciPy's t.ppf), by bisection on
// the tail, to full double precision.
export function tQuantile(p: number, df: number): number {
  if (p === 0.5) return 0;
  if (p < 0.5) return -tQuantile(1 - p, df);
  const tail = 2 * (1 - p);
  let lo = 0;
  let hi = 1;
  while (tTwoSided(hi, df) > tail) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (tTwoSided(mid, df) > tail) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Half the width of the 95% confidence interval of a mean: t(0.975, n − 1) × SEM.
export function ci95Half(xs: readonly number[]): number {
  return tQuantile(0.975, xs.length - 1) * sem(xs);
}

export type Summary = { n: number; mean: number; sd: number | null; sem: number | null; ci: number | null };

// A group of repeats, summarized. SD, SEM and the CI need at least two values.
export function summarize(xs: readonly number[]): Summary {
  const n = xs.length;
  if (n === 0) return { n, mean: Number.NaN, sd: null, sem: null, ci: null };
  if (n === 1) return { n, mean: xs[0], sd: null, sem: null, ci: null };
  return { n, mean: mean(xs), sd: sd(xs), sem: sem(xs), ci: ci95Half(xs) };
}

export type TestResult = { kind: "ok"; statistic: number; df: number; df2: number | null; p: number } | { kind: "undefined"; reason: string };

// Welch's t-test: two groups, not assuming they vary the same (SciPy's ttest_ind, equal_var=False).
export function welch(a: readonly number[], b: readonly number[]): TestResult {
  if (a.length < 2 || b.length < 2) return { kind: "undefined", reason: "Each group needs at least 2 values." };
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  if (va + vb === 0) return { kind: "undefined", reason: "Every value in both groups is the same, so there's no spread to test against." };
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  return { kind: "ok", statistic: t, df, df2: null, p: tTwoSided(t, df) };
}

// One-way ANOVA: do three or more group means differ (SciPy's f_oneway)?
export function anova(groups: readonly (readonly number[])[]): TestResult {
  if (groups.length < 2) return { kind: "undefined", reason: "There's only one group." };
  if (groups.some((g) => g.length < 2)) return { kind: "undefined", reason: "Each group needs at least 2 values." };
  const all = groups.flat();
  const grand = mean(all);
  let between = 0;
  let within = 0;
  for (const g of groups) {
    const m = mean(g);
    between += g.length * (m - grand) ** 2;
    for (const x of g) within += (x - m) ** 2;
  }
  const d1 = groups.length - 1;
  const d2 = all.length - groups.length;
  if (within === 0) return { kind: "undefined", reason: "The repeats in every group are identical, so there's no spread to test against." };
  const f = between / d1 / (within / d2);
  return { kind: "ok", statistic: f, df: d1, df2: d2, p: fUpperTail(f, d1, d2) };
}

// Holm's step-down correction for testing several things at once: the smallest p is multiplied
// by the number of tests, the next by one fewer, and so on, never going down, at most 1.
export function holm(ps: readonly number[]): number[] {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const out = new Array<number>(ps.length);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (ps.length - rank) * p));
    out[i] = running;
  });
  return out;
}

export type LineFit = { slope: number; intercept: number; r2: number; n: number; origin: boolean };

// A straight line by least squares, or through the origin (y = slope × x). R² is
// 1 − (sum of squared residuals) / (sum of squares about the mean of y) for both, so the two
// fits compare on one scale; through the origin it can be below zero when the line fits worse
// than a flat one. (Excel's LINEST and R's lm measure a through-origin R² about zero instead,
// which reads higher.) Null when x doesn't vary.
export function fitLine(xs: readonly number[], ys: readonly number[], origin = false): LineFit | null {
  const n = xs.length;
  if (n < 2) return null;
  const my = mean(ys);
  let slope: number;
  let intercept: number;
  if (origin) {
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += xs[i] * ys[i];
      sxx += xs[i] * xs[i];
    }
    if (sxx === 0) return null;
    slope = sxy / sxx;
    intercept = 0;
  } else {
    const mx = mean(xs);
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
    }
    if (sxx === 0) return null;
    slope = sxy / sxx;
    intercept = my - slope * mx;
  }
  let res = 0;
  let tot = 0;
  for (let i = 0; i < n; i++) {
    res += (ys[i] - (intercept + slope * xs[i])) ** 2;
    tot += (ys[i] - my) ** 2;
  }
  return { slope, intercept, r2: tot === 0 ? (res === 0 ? 1 : 0) : 1 - res / tot, n, origin };
}

// Quartiles by linear interpolation between the sorted values: NumPy's default percentile,
// Excel's QUARTILE.INC and R's type 7.
export function quantile(sorted: readonly number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export type Box = { q1: number; median: number; q3: number; low: number; high: number; outliers: number[] };

// A box plot's numbers: the quartiles, whiskers to the furthest values within 1.5 × the box's
// height of it (Tukey's rule), and the values past them.
export function boxStats(xs: readonly number[]): Box {
  const sorted = [...xs].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  const reach = 1.5 * (q3 - q1);
  const inside = sorted.filter((x) => x >= q1 - reach && x <= q3 + reach);
  return { q1, median, q3, low: inside[0] ?? q1, high: inside.at(-1) ?? q3, outliers: sorted.filter((x) => x < q1 - reach || x > q3 + reach) };
}

// The bin width the Freedman–Diaconis rule asks for (2 × IQR × n^(−1/3)), falling back to
// Sturges' (range / (log2 n + 1)) when the middle half of the values are all the same.
export function rawBinWidth(xs: readonly number[]): { width: number; rule: "Freedman–Diaconis" | "Sturges" } {
  const sorted = [...xs].sort((a, b) => a - b);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  if (iqr > 0) return { width: (2 * iqr) / Math.cbrt(sorted.length), rule: "Freedman–Diaconis" };
  const range = sorted[sorted.length - 1] - sorted[0];
  return { width: range > 0 ? range / (Math.log2(sorted.length) + 1) : 1, rule: "Sturges" };
}

// The round number nearest a width: 1, 2 or 5 times a power of ten, so bins read as "2 µm".
export function roundWidth(width: number): number {
  const power = 10 ** Math.floor(Math.log10(width));
  const scaled = width / power;
  const step = scaled < 1.5 ? 1 : scaled < 3.5 ? 2 : scaled < 7.5 ? 5 : 10;
  return Number((step * power).toPrecision(12));
}

// Bin edges `width` apart on multiples of it, covering every value; each bin holds the values
// from its left edge up to, not including, its right one.
export function binEdges(xs: readonly number[], width: number): number[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  const first = Math.floor(lo / width + 1e-9);
  const last = Math.floor(hi / width + 1e-9) + 1;
  const edges: number[] = [];
  for (let i = first; i <= last && edges.length <= 501; i++) edges.push(Number((i * width).toPrecision(12)));
  return edges;
}

export function binCounts(xs: readonly number[], edges: readonly number[]): number[] {
  const counts = new Array<number>(Math.max(0, edges.length - 1)).fill(0);
  for (const x of xs) {
    let lo = 0;
    let hi = edges.length - 1;
    if (x < edges[0] || x > edges[hi]) continue;
    // The last edge closes the last bin, as NumPy's histogram does.
    if (x === edges[hi]) {
      counts[hi - 1]++;
      continue;
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x >= edges[mid]) lo = mid;
      else hi = mid;
    }
    counts[lo]++;
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// The four-parameter logistic (4PL) dose-response curve, on log10 of the concentration:
//   y = bottom + (top − bottom) / (1 + 10^((logMid − x) × hill))
// fitted by Levenberg–Marquardt least squares, as SciPy's curve_fit does. logMid is the log of
// the IC50 or EC50, the concentration halfway between bottom and top.

export type FourPL = { bottom: number; top: number; logMid: number; hill: number };

export function fourPL(p: FourPL, x: number): number {
  return p.bottom + (p.top - p.bottom) * logistic((p.logMid - x) * p.hill * Math.LN10);
}

// 1 / (1 + e^u), without overflow.
function logistic(u: number): number {
  if (u > 0) {
    const e = Math.exp(-u);
    return e / (1 + e);
  }
  return 1 / (1 + Math.exp(u));
}

const toArray = (p: FourPL) => [p.bottom, p.top, p.logMid, p.hill];
const fromArray = (a: readonly number[]): FourPL => ({ bottom: a[0], top: a[1], logMid: a[2], hill: a[3] });

// Each point's partial derivatives with respect to bottom, top, logMid and hill.
function jacobianRow(p: FourPL, x: number): number[] {
  const s = logistic((p.logMid - x) * p.hill * Math.LN10);
  const slope = -(p.top - p.bottom) * s * (1 - s) * Math.LN10;
  return [1 - s, s, slope * p.hill, slope * (p.logMid - x)];
}

function sumSquares(p: FourPL, xs: readonly number[], ys: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (ys[i] - fourPL(p, xs[i])) ** 2;
  return s;
}

// Solves a small symmetric system by Gaussian elimination with partial pivoting; null when
// it's singular.
export function solve(a: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (!(Math.abs(m[pivot][c]) > 1e-300)) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

export function invert(a: readonly (readonly number[])[]): number[][] | null {
  const n = a.length;
  const columns: number[][] = [];
  for (let c = 0; c < n; c++) {
    const col = solve(
      a,
      a.map((_, i) => (i === c ? 1 : 0)),
    );
    if (col === null) return null;
    columns.push(col);
  }
  return a.map((_, r) => columns.map((col) => col[r]));
}

function normalMatrix(p: FourPL, xs: readonly number[], ys: readonly number[]): { jtj: number[][]; jtr: number[] } {
  const jtj = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  const jtr = [0, 0, 0, 0];
  for (let i = 0; i < xs.length; i++) {
    const row = jacobianRow(p, xs[i]);
    const r = ys[i] - fourPL(p, xs[i]);
    for (let a = 0; a < 4; a++) {
      jtr[a] += row[a] * r;
      for (let b = 0; b < 4; b++) jtj[a][b] += row[a] * row[b];
    }
  }
  return { jtj, jtr };
}

type Minimum = { kind: "converged"; params: FourPL; ssr: number } | { kind: "stuck" };

function levenbergMarquardt(start: FourPL, xs: readonly number[], ys: readonly number[]): Minimum {
  let p = start;
  let ssr = sumSquares(p, xs, ys);
  let lambda = 1e-3;
  for (let iter = 0; iter < 2000; iter++) {
    const { jtj, jtr } = normalMatrix(p, xs, ys);
    const damped = jtj.map((row, i) => row.map((v, j) => (i === j ? v + lambda * Math.max(v, 1e-12) : v)));
    const step = solve(damped, jtr);
    if (step === null) return { kind: "stuck" };
    const nextArray = toArray(p).map((v, i) => v + step[i]);
    if (!nextArray.every(Number.isFinite)) return { kind: "stuck" };
    const next = fromArray(nextArray);
    const nextSsr = sumSquares(next, xs, ys);
    if (nextSsr <= ssr) {
      const gained = ssr - nextSsr;
      const moved = Math.max(...step.map((s, i) => Math.abs(s) / (Math.abs(toArray(p)[i]) + 1e-8)));
      p = next;
      ssr = nextSsr;
      lambda = Math.max(lambda / 10, 1e-12);
      if (Math.abs(p.hill) > 50) return { kind: "stuck" };
      if (gained <= 1e-15 * ssr + 1e-300 && moved < 1e-9) return { kind: "converged", params: p, ssr };
    } else {
      lambda *= 10;
      if (lambda > 1e14) {
        // No step downhill: a minimum if the slope there is flat.
        const grad = Math.max(...jtr.map(Math.abs));
        const scale = Math.sqrt(Math.max(...jtj.map((row, i) => row[i]))) * Math.sqrt(ssr) + 1e-300;
        return grad <= 1e-7 * scale ? { kind: "converged", params: p, ssr } : { kind: "stuck" };
      }
    }
  }
  return { kind: "stuck" };
}

export type DoseFit =
  | {
      kind: "fit";
      params: FourPL;
      // The 95% confidence range of logMid, from the fit's covariance (as curve_fit's pcov):
      // SSR / (n − 4) × (JᵀJ)⁻¹, with t on n − 4 degrees of freedom. Null when it can't be had.
      logMidCi: [number, number] | null;
      se: FourPL | null;
      ssr: number;
      n: number;
      df: number;
      // Whether the 4PL beats a flat line, by the extra sum-of-squares F test.
      flatP: number;
      rising: boolean;
    }
  | { kind: "too-few"; doses: number }
  // The response jumps from one level to the other between two neighboring doses, so the
  // slope can't be measured: any steep enough curve fits.
  | { kind: "step"; between: [number, number] }
  // The curve is no better than a flat line (p of the F test at or above 0.05).
  | { kind: "flat"; p: number }
  | { kind: "no-fit" };

// Fits the 4PL to points at log10 concentrations xs. Starts from the data's own levels and a
// few midpoints, keeps the best minimum, and reports top above bottom with the slope's sign
// saying which way the curve runs.
export function fitDose(xs: readonly number[], ys: readonly number[]): DoseFit {
  const doses = [...new Set(xs)].sort((a, b) => a - b);
  if (doses.length < 5) return { kind: "too-few", doses: doses.length };
  const means = doses.map((d) => mean(ys.filter((_, i) => xs[i] === d)));
  const lo = Math.min(...means);
  const hi = Math.max(...means);
  const rising = means[means.length - 1] >= means[0];
  const mids = [0.5, 0.25, 0.75].map((f) => doses[0] + f * (doses[doses.length - 1] - doses[0]));
  let best: { params: FourPL; ssr: number } | null = null;
  for (const logMid of mids) {
    for (const hill of [1, 0.5, 2]) {
      const start = { bottom: lo, top: hi, logMid, hill: rising ? hill : -hill };
      const found = levenbergMarquardt(start, xs, ys);
      if (found.kind === "converged" && (best === null || found.ssr < best.ssr - 1e-12 * found.ssr)) best = found;
    }
  }
  if (best === null) return { kind: "no-fit" };
  let params = best.params;
  if (params.top < params.bottom) params = { bottom: params.top, top: params.bottom, logMid: params.logMid, hill: -params.hill };
  const n = xs.length;
  const df = n - 4;
  const ssr = best.ssr;
  // Is the curve any better than a flat line at the mean? The extra sum-of-squares F test,
  // 3 parameters more, on n − 4 degrees of freedom.
  const flat = ys.reduce((s, y) => s + (y - mean(ys)) ** 2, 0);
  const flatP = df > 0 && ssr > 0 ? fUpperTail((flat - ssr) / 3 / (ssr / df), 3, df) : flat > 0 ? 0 : 1;
  if (flatP >= 0.05) return { kind: "flat", p: flatP };
  // The curve goes from 10% to 90% of the way over log10(81) / |hill| decades. Narrower than
  // half the gap between the doses either side of its middle, and no dose sits on the slope.
  const after = doses.findIndex((d) => d > params.logMid);
  if (after > 0) {
    const gap = doses[after] - doses[after - 1];
    if (Math.log10(81) / Math.abs(params.hill) < gap / 2) return { kind: "step", between: [doses[after - 1], doses[after]] };
  }
  const { jtj } = normalMatrix(params, xs, ys);
  const inverse = df > 0 ? invert(jtj) : null;
  const s2 = df > 0 ? ssr / df : Number.NaN;
  const variances = inverse === null ? null : inverse.map((row, i) => row[i] * s2);
  const se = variances !== null && variances.every((v) => v >= 0 && Number.isFinite(v)) ? fromArray(variances.map(Math.sqrt)) : null;
  const t = df > 0 ? tQuantile(0.975, df) : Number.NaN;
  const logMidCi: [number, number] | null = se === null ? null : [params.logMid - t * se.logMid, params.logMid + t * se.logMid];
  return { kind: "fit", params, logMidCi, se, ssr, n, df, flatP, rising: params.hill > 0 };
}
