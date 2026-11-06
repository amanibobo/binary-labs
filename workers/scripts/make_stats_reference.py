"""Writes the reference values the web app's statistics are tested against
(apps/web/src/lib/__tests__/stats-reference.json), from SciPy and NumPy.

uv run python scripts/make_stats_reference.py

Each case carries its own inputs, so the TypeScript test reads the same numbers it checks.
Blank cells (NaN in a sheet) are written as null; the charts leave them out before any
statistic, so the references here are computed on the values that remain.
"""

from __future__ import annotations

import json
import math
import warnings
from pathlib import Path
from typing import Any

import numpy as np
from scipy import optimize, stats

OUT = Path(__file__).resolve().parents[2] / "apps/web/src/lib/__tests__/stats-reference.json"


def clean(values: list[float | None]) -> np.ndarray:
    return np.array([v for v in values if v is not None and not math.isnan(v)], dtype=float)


def summary_case(name: str, values: list[float | None]) -> dict[str, Any]:
    x = clean(values)
    n = len(x)
    out: dict[str, Any] = {"name": name, "values": values, "n": n, "mean": float(np.mean(x))}
    if n >= 2:
        sd = float(np.std(x, ddof=1))
        out |= {
            "sd": sd,
            "sem": float(stats.sem(x)),
            "ci": float(stats.t.ppf(0.975, n - 1) * stats.sem(x)),
        }
    return out


def welch_case(name: str, a: list[float], b: list[float]) -> dict[str, Any]:
    res = stats.ttest_ind(a, b, equal_var=False)
    return {
        "name": name,
        "a": a,
        "b": b,
        "t": float(res.statistic),
        "df": float(res.df),
        "p": float(res.pvalue),
    }


def anova_case(name: str, groups: list[list[float]]) -> dict[str, Any]:
    res = stats.f_oneway(*groups)
    k = len(groups)
    n = sum(len(g) for g in groups)
    return {
        "name": name,
        "groups": groups,
        "f": float(res.statistic),
        "df1": k - 1,
        "df2": n - k,
        "p": float(res.pvalue),
    }


def holm(ps: list[float]) -> list[float]:
    """Holm's step-down adjustment, written out from its definition (statsmodels'
    multipletests(method="holm") gives the same)."""
    m = len(ps)
    order = np.argsort(ps, kind="stable")
    adjusted = np.empty(m)
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * ps[i]))
        adjusted[i] = running
    return adjusted.tolist()


def vs_control_case(name: str, control: list[float], others: list[list[float]]) -> dict[str, Any]:
    raw = [float(stats.ttest_ind(o, control, equal_var=False).pvalue) for o in others]
    return {"name": name, "control": control, "others": others, "raw": raw, "holm": holm(raw)}


def line_case(name: str, x: list[float], y: list[float]) -> dict[str, Any]:
    xs, ys = np.array(x), np.array(y)
    lr = stats.linregress(xs, ys)
    slope0 = float(np.sum(xs * ys) / np.sum(xs * xs))
    resid0 = ys - slope0 * xs
    r2_0 = 1 - float(np.sum(resid0**2) / np.sum((ys - ys.mean()) ** 2))
    return {
        "name": name,
        "x": x,
        "y": y,
        "slope": float(lr.slope),
        "intercept": float(lr.intercept),
        "r2": float(lr.rvalue**2),
        "originSlope": slope0,
        "originR2": r2_0,
    }


def four_pl(x: np.ndarray, bottom: float, top: float, log_mid: float, hill: float) -> np.ndarray:
    return bottom + (top - bottom) / (1 + 10 ** ((log_mid - x) * hill))


def dose_case(name: str, conc: list[float], y: list[float], p0: list[float]) -> dict[str, Any]:
    xs = np.log10(np.array(conc))
    ys = np.array(y)
    out: dict[str, Any] = {"name": name, "conc": conc, "y": y}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", optimize.OptimizeWarning)
            popt, pcov = optimize.curve_fit(
                four_pl, xs, ys, p0=p0, maxfev=20000, ftol=1e-15, xtol=1e-15, gtol=1e-15
            )
    except (RuntimeError, optimize.OptimizeWarning) as e:
        return out | {"fits": False, "why": str(e)[:120]}
    bottom, top, log_mid, hill = (float(v) for v in popt)
    if top < bottom:
        bottom, top, hill = top, bottom, -hill
    if abs(hill) > 50:
        return out | {"fits": False, "why": f"hill {hill:.3g}: a step, not a curve"}
    df = len(ys) - 4
    se = float(np.sqrt(pcov[2, 2]))
    t = float(stats.t.ppf(0.975, df))
    ssr = float(np.sum((ys - four_pl(xs, *popt)) ** 2))
    flat = float(np.sum((ys - ys.mean()) ** 2))
    f = (flat - ssr) / 3 / (ssr / df)
    return out | {
        "fits": True,
        "bottom": bottom,
        "top": top,
        "logMid": log_mid,
        "hill": hill,
        "seLogMid": se,
        "ciLogLo": log_mid - t * se,
        "ciLogHi": log_mid + t * se,
        "mid": 10**log_mid,
        "ssr": ssr,
        "flatP": float(stats.f.sf(f, 3, df)),
    }


def box_case(name: str, values: list[float]) -> dict[str, Any]:
    x = np.array(values)
    q1, med, q3 = (float(v) for v in np.percentile(x, [25, 50, 75]))
    return {"name": name, "values": values, "q1": q1, "median": med, "q3": q3}


def histogram_case(name: str, values: list[float], width: float) -> dict[str, Any]:
    x = np.array(values)
    q75, q25 = np.percentile(x, [75, 25])
    fd_width = 2 * (q75 - q25) / len(x) ** (1 / 3)
    lo = math.floor(x.min() / width + 1e-9)
    hi = math.floor(x.max() / width + 1e-9) + 1
    edges = [round(i * width, 12) for i in range(lo, hi + 1)]
    counts, _ = np.histogram(x, bins=edges)
    return {
        "name": name,
        "values": values,
        "fdWidth": float(fd_width),
        "width": width,
        "edges": edges,
        "counts": counts.tolist(),
    }


def dose_values(
    conc: list[float], truth: tuple[float, float, float, float], noise: list[float], reps: int = 3
) -> tuple[list[float], list[float]]:
    xs: list[float] = []
    ys: list[float] = []
    k = 0
    for c in conc:
        for _ in range(reps):
            xs.append(c)
            ys.append(round(float(four_pl(np.log10(c), *truth)) + noise[k % len(noise)], 4))
            k += 1
    return xs, ys


def main() -> None:
    rng = np.random.default_rng(2026)
    noise = [round(float(v), 4) for v in rng.normal(0, 0.03, 60)]
    drug_x, drug_y = dose_values(
        [0.1, 0.3, 1, 3, 10, 30, 100], (0.08, 1.0, math.log10(2.4), -1.1), noise
    )
    agonist_x, agonist_y = dose_values(
        [0.01, 0.1, 1, 10, 100, 1000], (5, 95, 0.7, 0.9), [v * 60 for v in noise]
    )
    outside_x, outside_y = dose_values(
        [0.01, 0.03, 0.1, 0.3, 1, 3, 10], (0.1, 1.0, 1.4, -1.0), noise
    )
    flat_x, flat_y = dose_values([0.1, 1, 10, 100, 1000], (1.0, 1.0, 1.0, -1.0), noise)
    cells = [round(float(v), 2) for v in rng.lognormal(math.log(12), 0.25, 200)]
    ref = {
        "summaries": [
            summary_case("three repeats", [0.512, 0.498, 0.533]),
            summary_case("two repeats", [1.2, 1.5]),
            summary_case("ties", [4.0, 4.0, 4.0, 5.0]),
            summary_case("zeros and a blank cell", [0.0, 0.0, None, 0.3, 0.1]),
            summary_case("ten wells", [float(v) for v in np.round(rng.normal(50, 4, 10), 3)]),
            summary_case("one value", [7.5]),
        ],
        "welch": [
            welch_case(
                "knockdown vs control, n = 4", [1.02, 0.96, 1.08, 0.94], [0.61, 0.55, 0.72, 0.58]
            ),
            welch_case(
                "unequal sizes and spreads", [12.1, 15.3, 9.8, 14.4, 11.0, 13.2], [18.2, 25.9, 16.0]
            ),
            welch_case("n = 2 each", [3.1, 3.4], [2.2, 2.9]),
            welch_case("no difference", [5.0, 5.2, 4.8], [5.1, 4.9, 5.0]),
        ],
        "anova": [
            anova_case(
                "four groups",
                [
                    [2.1, 2.4, 2.2, 2.6],
                    [3.0, 3.3, 2.9, 3.5],
                    [2.3, 2.0, 2.5, 2.2],
                    [4.1, 3.8, 4.4, 4.0],
                ],
            ),
            anova_case(
                "three groups, uneven", [[10.0, 11.5, 9.0], [12.0, 13.5, 12.5, 14.0], [9.5, 10.5]]
            ),
            anova_case("ties within groups", [[1.0, 1.0, 2.0], [2.0, 2.0, 3.0], [1.0, 2.0, 2.0]]),
        ],
        "vsControl": [
            vs_control_case(
                "three treatments",
                [1.0, 1.1, 0.9, 1.05],
                [[1.4, 1.6, 1.5, 1.45], [1.02, 0.98, 1.1, 1.0], [0.7, 0.75, 0.6, 0.72]],
            ),
        ],
        "holm": [
            {"p": [0.01, 0.04, 0.03, 0.005], "adjusted": holm([0.01, 0.04, 0.03, 0.005])},
            {"p": [0.5, 0.5, 0.01], "adjusted": holm([0.5, 0.5, 0.01])},
            {"p": [0.3, 0.6], "adjusted": holm([0.3, 0.6])},
        ],
        "lines": [
            line_case(
                "Bradford standards",
                [0, 125, 250, 500, 750, 1000],
                [0.431, 0.512, 0.578, 0.736, 0.884, 1.04],
            ),
            line_case(
                "pendulum: length vs period squared",
                [0.2, 0.4, 0.6, 0.8, 1.0, 1.2],
                [0.81, 1.62, 2.40, 3.22, 4.03, 4.80],
            ),
            line_case("a poor straight line", [1, 2, 3, 4, 5], [5, 1, 4, 2, 6]),
        ],
        "doses": [
            dose_case("drug A inhibits", drug_x, drug_y, [0.08, 1.0, 0.5, -1.0]),
            dose_case("agonist activates", agonist_x, agonist_y, [5, 95, 1.0, 1.0]),
            dose_case("bottom not reached", outside_x, outside_y, [0.1, 1.0, 0.5, -1.0]),
            dose_case("flat", flat_x, flat_y, [0.9, 1.1, 1.0, -1.0]),
            dose_case(
                "a step between two doses",
                [1, 1, 10, 10, 100, 100, 1000, 1000, 1e4, 1e4],
                [0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
                [0, 1, 2.5, 1],
            ),
        ],
        "boxes": [
            box_case("eight values", [3.1, 4.7, 2.2, 5.9, 4.4, 3.8, 9.6, 4.0]),
            box_case("ties", [1, 2, 2, 2, 3, 3, 10]),
            box_case("two values", [1.0, 4.0]),
        ],
        "histograms": [
            histogram_case("200 cell sizes", cells, 1.0),
            histogram_case("200 cell sizes, wider bins", cells, 2.0),
            histogram_case("small set", [1.0, 1.5, 2.0, 2.0, 3.5, 4.0, 4.0, 4.0, 6.0], 1.0),
        ],
        "quantiles": [
            {"p": p, "df": df, "t": float(stats.t.ppf(p, df))}
            for p in (0.975, 0.995, 0.9, 0.6)
            for df in (1, 2, 3, 5, 11, 30, 120)
        ],
    }
    OUT.write_text(json.dumps(ref, indent=1) + "\n")
    print(f"{OUT}: {len(json.dumps(ref))} bytes")


if __name__ == "__main__":
    main()
