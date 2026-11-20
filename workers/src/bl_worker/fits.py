"""Curve fits for checks: a straight line and the four-parameter logistic (4PL).

A line-for-line port of fitLine and fitDose in apps/web/src/lib/stats.ts, so a check's R² or
IC50 is the number the chart of the same file shows. Both are tested against the same SciPy
answers (apps/web/src/lib/__tests__/stats-reference.json) and the worked example.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

# Lines ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class LineFit:
    slope: float
    intercept: float
    r2: float


def fit_line(xs: Sequence[float], ys: Sequence[float]) -> LineFit | None:
    """Least squares with an intercept; R² is 1 - SSres/SStot. None when x doesn't vary."""
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / sxx
    intercept = my - slope * mx
    res = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(xs, ys, strict=True))
    tot = sum((y - my) ** 2 for y in ys)
    r2 = (1.0 if res == 0 else 0.0) if tot == 0 else 1 - res / tot
    return LineFit(slope, intercept, r2)


# Distributions ----------------------------------------------------------------------------

_LANCZOS = (
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
)


def _ln_gamma(x: float) -> float:
    if x < 0.5:
        return math.log(math.pi / abs(math.sin(math.pi * x))) - _ln_gamma(1 - x)
    z = x - 1
    a = _LANCZOS[0]
    t = z + 7.5
    for i in range(1, 9):
        a += _LANCZOS[i] / (z + i)
    return 0.5 * math.log(2 * math.pi) + (z + 0.5) * math.log(t) - t + math.log(a)


def _beta_fraction(x: float, a: float, b: float) -> float:
    tiny = 1e-300
    c = 1.0
    d = 1 - (a + b) * x / (a + 1)
    if abs(d) < tiny:
        d = tiny
    d = 1 / d
    h = d
    for m in range(1, 1001):
        m2 = 2 * m
        aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2))
        d = 1 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        h *= d * c
        aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1))
        d = 1 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        step = d * c
        h *= step
        if abs(step - 1) < 1e-16:
            break
    return h


def _incomplete_beta(x: float, a: float, b: float) -> float:
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    front = math.exp(
        _ln_gamma(a + b) - _ln_gamma(a) - _ln_gamma(b) + a * math.log(x) + b * math.log1p(-x)
    )
    if x < (a + 1) / (a + b + 2):
        return front * _beta_fraction(x, a, b) / a
    return 1 - front * _beta_fraction(1 - x, b, a) / b


def _t_two_sided(t: float, df: float) -> float:
    if not math.isfinite(t):
        return 0.0
    return _incomplete_beta(df / (df + t * t), df / 2, 0.5)


def _f_upper_tail(f: float, d1: float, d2: float) -> float:
    if f <= 0:
        return 1.0
    if not math.isfinite(f):
        return 0.0
    return _incomplete_beta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2)


def t_quantile(p: float, df: float) -> float:
    if p == 0.5:
        return 0.0
    if p < 0.5:
        return -t_quantile(1 - p, df)
    tail = 2 * (1 - p)
    lo, hi = 0.0, 1.0
    while _t_two_sided(hi, df) > tail:
        hi *= 2
    for _ in range(200):
        mid = (lo + hi) / 2
        if mid in (lo, hi):
            break
        if _t_two_sided(mid, df) > tail:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


# The 4PL ----------------------------------------------------------------------------------
# y = bottom + (top - bottom) / (1 + 10^((log_mid - x) * hill)), x the log10 concentration.

Params = tuple[float, float, float, float]  # bottom, top, log_mid, hill


def _logistic(u: float) -> float:
    if u > 0:
        e = math.exp(-u)
        return e / (1 + e)
    return 1 / (1 + math.exp(u))


def four_pl(p: Params, x: float) -> float:
    bottom, top, log_mid, hill = p
    return bottom + (top - bottom) * _logistic((log_mid - x) * hill * math.log(10))


def _jacobian_row(p: Params, x: float) -> list[float]:
    bottom, top, log_mid, hill = p
    s = _logistic((log_mid - x) * hill * math.log(10))
    slope = -(top - bottom) * s * (1 - s) * math.log(10)
    return [1 - s, s, slope * hill, slope * (log_mid - x)]


def _sum_squares(p: Params, xs: Sequence[float], ys: Sequence[float]) -> float:
    return sum((y - four_pl(p, x)) ** 2 for x, y in zip(xs, ys, strict=True))


def _solve(a: Sequence[Sequence[float]], b: Sequence[float]) -> list[float] | None:
    n = len(b)
    m = [[*row, b[i]] for i, row in enumerate(a)]
    for c in range(n):
        pivot = c
        for r in range(c + 1, n):
            if abs(m[r][c]) > abs(m[pivot][c]):
                pivot = r
        if not abs(m[pivot][c]) > 1e-300:
            return None
        m[c], m[pivot] = m[pivot], m[c]
        for r in range(n):
            if r == c:
                continue
            f = m[r][c] / m[c][c]
            for k in range(c, n + 1):
                m[r][k] -= f * m[c][k]
    return [row[n] / row[i] for i, row in enumerate(m)]


def _invert(a: Sequence[Sequence[float]]) -> list[list[float]] | None:
    n = len(a)
    columns = []
    for c in range(n):
        col = _solve(a, [1.0 if i == c else 0.0 for i in range(n)])
        if col is None:
            return None
        columns.append(col)
    return [[col[r] for col in columns] for r in range(n)]


def _normal_matrix(
    p: Params, xs: Sequence[float], ys: Sequence[float]
) -> tuple[list[list[float]], list[float]]:
    jtj = [[0.0] * 4 for _ in range(4)]
    jtr = [0.0] * 4
    for x, y in zip(xs, ys, strict=True):
        row = _jacobian_row(p, x)
        r = y - four_pl(p, x)
        for a in range(4):
            jtr[a] += row[a] * r
            for b in range(4):
                jtj[a][b] += row[a] * row[b]
    return jtj, jtr


def _levenberg_marquardt(
    start: Params, xs: Sequence[float], ys: Sequence[float]
) -> tuple[Params, float] | None:
    p = start
    ssr = _sum_squares(p, xs, ys)
    lam = 1e-3
    for _ in range(2000):
        jtj, jtr = _normal_matrix(p, xs, ys)
        damped = [
            [v + lam * max(v, 1e-12) if i == j else v for j, v in enumerate(row)]
            for i, row in enumerate(jtj)
        ]
        step = _solve(damped, jtr)
        if step is None:
            return None
        nxt = tuple(v + s for v, s in zip(p, step, strict=True))
        if not all(math.isfinite(v) for v in nxt):
            return None
        next_ssr = _sum_squares(nxt, xs, ys)  # type: ignore[arg-type]
        if next_ssr <= ssr:
            gained = ssr - next_ssr
            moved = max(abs(s) / (abs(v) + 1e-8) for s, v in zip(step, p, strict=True))
            p = nxt  # type: ignore[assignment]
            ssr = next_ssr
            lam = max(lam / 10, 1e-12)
            if abs(p[3]) > 50:
                return None
            if gained <= 1e-15 * ssr + 1e-300 and moved < 1e-9:
                return p, ssr
        else:
            lam *= 10
            if lam > 1e14:
                grad = max(abs(g) for g in jtr)
                scale = math.sqrt(max(jtj[i][i] for i in range(4))) * math.sqrt(ssr) + 1e-300
                return (p, ssr) if grad <= 1e-7 * scale else None
    return None


@dataclass(frozen=True)
class DoseFit:
    kind: Literal["fit"]
    params: Params
    log_mid_ci: tuple[float, float] | None
    ssr: float
    sst: float
    flat_p: float

    @property
    def r2(self) -> float:
        return 1 - self.ssr / self.sst if self.sst > 0 else 1.0


@dataclass(frozen=True)
class DoseRefusal:
    kind: Literal["too-few", "no-fit", "flat", "step"]
    doses: int = 0
    between: tuple[float, float] | None = None


def fit_dose(xs: Sequence[float], ys: Sequence[float]) -> DoseFit | DoseRefusal:
    """The 4PL at log10 concentrations xs: nine starts, the best minimum, top above bottom."""
    doses = sorted(set(xs))
    if len(doses) < 5:
        return DoseRefusal("too-few", doses=len(doses))
    means = []
    for d in doses:
        at = [y for x, y in zip(xs, ys, strict=True) if x == d]
        means.append(sum(at) / len(at))
    lo, hi = min(means), max(means)
    rising = means[-1] >= means[0]
    mids = [doses[0] + f * (doses[-1] - doses[0]) for f in (0.5, 0.25, 0.75)]
    best: tuple[Params, float] | None = None
    for log_mid in mids:
        for hill in (1.0, 0.5, 2.0):
            start = (lo, hi, log_mid, hill if rising else -hill)
            found = _levenberg_marquardt(start, xs, ys)
            if found is not None and (best is None or found[1] < best[1] - 1e-12 * found[1]):
                best = found
    if best is None:
        return DoseRefusal("no-fit")
    params, ssr = best
    if params[1] < params[0]:
        params = (params[1], params[0], params[2], -params[3])
    n = len(xs)
    df = n - 4
    my = sum(ys) / n
    flat = sum((y - my) ** 2 for y in ys)
    if df > 0 and ssr > 0:
        flat_p = _f_upper_tail((flat - ssr) / 3 / (ssr / df), 3, df)
    else:
        flat_p = 0.0 if flat > 0 else 1.0
    if flat_p >= 0.05:
        return DoseRefusal("flat")
    after = next((i for i, d in enumerate(doses) if d > params[2]), -1)
    if after > 0:
        gap = doses[after] - doses[after - 1]
        if math.log10(81) / abs(params[3]) < gap / 2:
            return DoseRefusal("step", between=(doses[after - 1], doses[after]))
    jtj, _ = _normal_matrix(params, xs, ys)
    inverse = _invert(jtj) if df > 0 else None
    ci = None
    if inverse is not None:
        variances = [inverse[i][i] * ssr / df for i in range(4)]
        if all(v >= 0 and math.isfinite(v) for v in variances):
            t = t_quantile(0.975, df)
            se = math.sqrt(variances[2])
            ci = (params[2] - t * se, params[2] + t * se)
    return DoseFit("fit", params, ci, ssr, flat, flat_p)
