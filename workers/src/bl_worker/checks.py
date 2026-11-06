"""Evaluating a protocol's checks against a file's parsed tables (decisions.md, "checking
results: expected values and flags"). Pure: it reads the JSON tables.py writes and returns, per
check, whether it passed, failed or couldn't be computed, with the cells it read.

A check's spec is the shape check_spec_ok in db/migrations/0018_checks.sql allows (CheckSpec in
apps/web/src/lib/checks.ts). Columns are named as the file names them, as "name (unit)", or by
letter. A check with no table named tries every table in the file, first to last.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from typing import Any, Literal

Outcome = Literal["passed", "flagged", "couldnt"]

MIN_POINTS = 3


@dataclass(frozen=True)
class Column:
    id: str
    name: str
    unit: str | None
    kind: str
    values: list[Any]

    @property
    def label(self) -> str:
        return self.name if not self.unit else f"{self.name} ({self.unit})"


@dataclass(frozen=True)
class Table:
    name: str
    rows: int
    truncated: bool
    rows_in_file: int | None
    columns: list[Column]

    def text_columns(self) -> list[Column]:
        return [c for c in self.columns if c.kind == "text"]

    def number_columns(self) -> list[Column]:
        return [c for c in self.columns if c.kind == "number"]


@dataclass(frozen=True)
class FileTables:
    sha256: str
    tables: list[Table]


def file_tables(sha256: str, doc: dict[str, Any]) -> FileTables:
    return FileTables(
        sha256,
        [
            Table(
                name=t["name"],
                rows=t["rows"],
                truncated=t["truncated"],
                rows_in_file=t.get("rowsInFile"),
                columns=[
                    Column(c["id"], c["name"], c.get("unit"), c["kind"], c["values"])
                    for c in t["columns"]
                ],
            )
            for t in doc["tables"]
        ],
    )


@dataclass(frozen=True)
class Cells:
    """Where a value was read: a file, one of its tables, columns by letter, rows by index."""

    sha256: str
    sheet: str
    columns: tuple[str, ...]
    rows: tuple[int, ...]

    def spans(self) -> list[tuple[int, int]]:
        """The rows as half-open [start, end) spans, the way int4multirange takes them."""
        spans: list[tuple[int, int]] = []
        for r in sorted(set(self.rows)):
            if spans and spans[-1][1] == r:
                spans[-1] = (spans[-1][0], r + 1)
            else:
                spans.append((r, r + 1))
        return spans


@dataclass(frozen=True)
class Result:
    outcome: Outcome
    observed: float | None = None
    unit: str | None = None
    reason: str | None = None
    source: Cells | None = None
    control: Cells | None = None


def couldnt(reason: str) -> Result:
    return Result("couldnt", reason=reason)


# Ranges -----------------------------------------------------------------------------------


def holds(r: dict[str, Any], v: float) -> bool:
    """range_holds in SQL, in the same float arithmetic."""
    match r["kind"]:
        case "at_least":
            return v >= float(r["min"])
        case "at_most":
            return v <= float(r["max"])
        case "between":
            return float(r["min"]) <= v <= float(r["max"])
        case "around":
            return abs(v - float(r["target"])) <= float(r["tolerance"])
    raise ValueError(f"unknown range {r!r}")


def distance(r: dict[str, Any], v: float) -> float:
    """How far outside the range a value is; negative inside it. Picks the worst control."""
    match r["kind"]:
        case "at_least":
            return float(r["min"]) - v
        case "at_most":
            return v - float(r["max"])
        case "between":
            return max(float(r["min"]) - v, v - float(r["max"]))
        case "around":
            return abs(v - float(r["target"])) - float(r["tolerance"])
    raise ValueError(f"unknown range {r!r}")


def tidy(x: float, digits: int = 6) -> float:
    """A computed value as people read it, and as it's compared: six significant digits."""
    return float(f"{x:.{digits}g}")


def judged(
    check: dict[str, Any],
    observed: float,
    unit: str | None,
    source: Cells,
    control: Cells | None = None,
) -> Result:
    outcome: Outcome = "passed" if holds(check["range"], observed) else "flagged"
    return Result(outcome, observed, unit, source=source, control=control)


# Tables and columns -----------------------------------------------------------------------


def _key(text: str) -> str:
    return " ".join(text.split()).casefold()


_LETTERS = re.compile(r"[A-Z]{1,3}")


def resolve(table: Table, ref: str) -> Column | None:
    """A column by its name, its name with the unit, or its letter, in that order."""
    want = _key(ref)
    for c in table.columns:
        if _key(c.name) == want:
            return c
    for c in table.columns:
        if _key(c.label) == want:
            return c
    if _LETTERS.fullmatch(ref.strip()):
        for c in table.columns:
            if c.id == ref.strip():
                return c
    return None


def _tables(file: FileTables, sheet: str | None) -> list[Table]:
    if sheet is None:
        return file.tables
    return [t for t in file.tables if _key(t.name) == _key(sheet)]


def _missing_table(sheet: str) -> Result:
    return couldnt(f"There's no table called “{sheet}” in this file.")


def _truncated(table: Table) -> Result:
    whole = f" of {table.rows_in_file:,}" if table.rows_in_file is not None else ""
    return couldnt(
        f"Only the first {table.rows:,}{whole} rows of “{table.name}” were read, so this check"
        " can't see them all."
    )


def _no_column(ref: str) -> Result:
    return couldnt(f"There's no column called “{ref}” in this file.")


def _number(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def _pairs(x: Column, y: Column, rows: int) -> list[tuple[int, float, float]]:
    out = []
    for i in range(rows):
        a, b = _number(x.values[i]), _number(y.values[i])
        if a is not None and b is not None:
            out.append((i, a, b))
    return out


# Working out columns a check leaves blank ---------------------------------------------------

_CONCENTRATION_NAME = re.compile(
    r"\b(conc\w*|standards?|std|bsa|bgg|amount|dose|protein)\b", re.IGNORECASE
)
_CONCENTRATION_UNIT = re.compile(r"^\s*[pnuµm]?(g|mol)\s*/\s*[mµu]?l\s*$|^\s*[pnuµm]?M\s*$")
_SIGNAL_NAME = re.compile(
    r"^\s*(a|od|abs)\s*\d{3}\b|absorbance|\bod\b|\babs\b|signal|fluor|\brfu\b|\brlu\b|lum|"
    r"intensity|\buv\b",
    re.IGNORECASE,
)
_SIGNAL_UNIT = re.compile(r"^\s*(m?AU|OD|RFU|RLU|counts)\s*$", re.IGNORECASE)
_MEAN_NAME = re.compile(r"\b(mean|average|avg)\b", re.IGNORECASE)
_AXIS_NAME = re.compile(
    r"wavelength|\bnm\b|volume|elution|retention|\btime\b|\bml\b", re.IGNORECASE
)
_AXIS_UNIT = re.compile(r"^\s*(nm|m?l|µl|min|s|h)\s*$", re.IGNORECASE)


def _is_signal(c: Column) -> bool:
    return bool(_SIGNAL_NAME.search(c.name) or (c.unit and _SIGNAL_UNIT.match(c.unit)))


def detect_curve(table: Table) -> tuple[Column, Column] | None:
    """Concentration and signal of a standard curve: a concentration by its name or unit, and
    the mean of the readings when there is one, else the first reading."""
    numbers = table.number_columns()
    xs = [
        c
        for c in numbers
        if _CONCENTRATION_NAME.search(c.name) or (c.unit and _CONCENTRATION_UNIT.match(c.unit))
    ]
    if not xs:
        return None
    x = xs[0]
    rest = [c for c in numbers if c.id != x.id]
    means = [c for c in rest if _MEAN_NAME.search(c.name)]
    signals = [c for c in rest if _is_signal(c)]
    y = (means or signals or (rest if len(rest) == 1 else [None]))[0]
    return None if y is None else (x, y)


def detect_trace(table: Table) -> tuple[Column, Column] | None:
    """The axis a peak sits on (wavelength, volume or time) and the signal along it."""
    numbers = table.number_columns()
    axes = [
        c for c in numbers if (c.unit and _AXIS_UNIT.match(c.unit)) or _AXIS_NAME.search(c.name)
    ]
    if not axes:
        return None
    x = axes[0]
    after = numbers[numbers.index(x) + 1 :]
    signals = [c for c in after if _is_signal(c)]
    y = (signals or after or [None])[0]
    return None if y is None else (x, y)


def _columns(
    file: FileTables,
    sheet: str | None,
    refs: Sequence[str | None],
    detect: Callable[[Table], tuple[Column, ...] | None],
    undetected: str,
) -> tuple[Table, tuple[Column, ...]] | Result:
    """The first table where every named column is found (or, with none named, worked out)."""
    tables = _tables(file, sheet)
    if sheet is not None and not tables:
        return _missing_table(sheet)
    missing: str | None = None
    for t in tables:
        if all(r is None for r in refs):
            found = detect(t)
            if found is not None:
                return t, found
            continue
        cols = [None if r is None else resolve(t, r) for r in refs]
        pairs = zip(refs, cols, strict=True)
        absent = next((r for r, c in pairs if r is not None and c is None), None)
        if absent is not None:
            missing = missing or absent
            continue
        if any(c is None for c in cols):
            found = detect(t)
            if found is None:
                continue
            cols = [c if c is not None else f for c, f in zip(cols, found, strict=True)]
            if len({c.id for c in cols if c is not None}) < len(cols):
                continue
        return t, tuple(c for c in cols if c is not None)
    if missing is not None:
        return _no_column(missing)
    named = next((r for r in refs if r is not None), None)
    if not tables and named is not None:
        return _no_column(named)
    return couldnt(undetected or "This file has no table to check.")


def _number_column(c: Column) -> Result | None:
    if c.kind != "number":
        return couldnt(f"“{c.label}” holds text, not numbers.")
    return None


# The four kinds of check ------------------------------------------------------------------


def curve_fit(check: dict[str, Any], file: FileTables) -> Result:
    """R² of a straight line through the standards, by least squares."""
    picked = _columns(
        file,
        check["sheet"],
        [check["x"], check["y"]],
        detect_curve,
        "Couldn't tell which columns are the concentration and the signal. Name them in the check.",
    )
    if isinstance(picked, Result):
        return picked
    table, (x, y) = picked
    if table.truncated:
        return _truncated(table)
    for c in (x, y):
        if (bad := _number_column(c)) is not None:
            return bad
    pairs = _pairs(x, y, table.rows)
    if len(pairs) < MIN_POINTS:
        return couldnt(
            f"Only {len(pairs)} standards have both a concentration and a reading; a fit needs"
            f" {MIN_POINTS}."
        )
    n = len(pairs)
    mx = sum(p[1] for p in pairs) / n
    my = sum(p[2] for p in pairs) / n
    sxx = sum((p[1] - mx) ** 2 for p in pairs)
    syy = sum((p[2] - my) ** 2 for p in pairs)
    sxy = sum((p[1] - mx) * (p[2] - my) for p in pairs)
    # Flat to within rounding: subtracting the mean leaves crumbs of float error, not variation.
    if sxx <= 1e-12 * sum(p[1] ** 2 for p in pairs) or syy <= 1e-12 * sum(p[2] ** 2 for p in pairs):
        return couldnt("The standards don't vary, so there's no line to fit.")
    r2 = round(sxy * sxy / (sxx * syy), 4)
    source = Cells(file.sha256, table.name, (x.id, y.id), tuple(p[0] for p in pairs))
    return judged(check, r2, check["unit"], source)


def peak(check: dict[str, Any], file: FileTables) -> Result:
    """Where the signal is highest along its axis: an absorbance maximum, an elution volume."""
    picked = _columns(
        file,
        check["sheet"],
        [check["x"], check["y"]],
        detect_trace,
        "Couldn't tell which columns are the axis and the signal. Name them in the check.",
    )
    if isinstance(picked, Result):
        return picked
    table, (x, y) = picked
    if table.truncated:
        return _truncated(table)
    for c in (x, y):
        if (bad := _number_column(c)) is not None:
            return bad
    pairs = _pairs(x, y, table.rows)
    if len(pairs) < MIN_POINTS:
        return couldnt(f"Only {len(pairs)} points have both values; a peak needs {MIN_POINTS}.")
    row, at, _ = max(pairs, key=lambda p: p[2])
    source = Cells(file.sha256, table.name, (x.id, y.id), (row,))
    return judged(check, tidy(at), check["unit"] or x.unit, source)


def _row_index(table: Table, row: str) -> int | None:
    text = row.strip()
    if text.isdigit():
        i = int(text) - 1
        return i if 0 <= i < table.rows else None
    want = _key(text)
    for i in range(table.rows):
        for c in table.text_columns():
            v = c.values[i]
            if isinstance(v, str) and _key(v) == want:
                return i
    return None


def value(check: dict[str, Any], file: FileTables) -> Result:
    """The mean, highest or lowest of a column, or one cell of it picked by its row."""
    picked = _columns(file, check["sheet"], [check["column"]], lambda _t: None, "")
    if isinstance(picked, Result):
        return picked
    table, (col,) = picked
    if (bad := _number_column(col)) is not None:
        return bad
    unit = check["unit"] or col.unit
    if check["stat"] == "cell":
        i = _row_index(table, check["row"])
        if i is None:
            return couldnt(f"There's no row “{check['row']}” in “{table.name}”.")
        v = _number(col.values[i])
        if v is None:
            return couldnt(f"The “{col.label}” cell in row “{check['row']}” is empty.")
        return judged(check, tidy(v), unit, Cells(file.sha256, table.name, (col.id,), (i,)))
    if table.truncated:
        return _truncated(table)
    found = [(i, v) for i in range(table.rows) if (v := _number(col.values[i])) is not None]
    if not found:
        return couldnt(f"“{col.label}” has no numbers in it.")
    rows = tuple(i for i, _ in found)
    match check["stat"]:
        case "mean":
            observed = sum(v for _, v in found) / len(found)
        case "max":
            i, observed = max(found, key=lambda p: p[1])
            rows = (i,)
        case "min":
            i, observed = min(found, key=lambda p: p[1])
            rows = (i,)
        case other:
            raise ValueError(f"unknown stat {other!r}")
    return judged(check, tidy(observed), unit, Cells(file.sha256, table.name, (col.id,), rows))


def _control_rows(table: Table, pattern: str, label: Column | None) -> tuple[list[int], set[str]]:
    want = _key(pattern)
    columns = [label] if label is not None else table.text_columns()
    rows, matched = [], set()
    for i in range(table.rows):
        for c in columns:
            v = c.values[i]
            if isinstance(v, str) and want in _key(v):
                rows.append(i)
                matched.add(c.id)
                break
    return rows, matched


def _find_controls(
    check: dict[str, Any], file: FileTables
) -> tuple[Table, Column, list[int], set[str]] | None:
    for t in _tables(file, check["sheet"]):
        col = resolve(t, check["column"])
        if col is None or col.kind != "number":
            continue
        label = None
        if check["labelColumn"] is not None:
            label = resolve(t, check["labelColumn"])
            if label is None:
                continue
        rows, matched = _control_rows(t, check["pattern"], label)
        if rows:
            return t, col, rows, matched
    return None


def control(
    check: dict[str, Any], file: FileTables, same_day: Callable[[], Iterable[FileTables]]
) -> Result:
    """The day's controls (rows whose name has the pattern in it, such as "blank") must sit in
    the range. They're read from this file, or else from another file of the same experiment and
    day. `each` judges every control, so the worst one is the value; `mean` judges their mean."""
    tables = _tables(file, check["sheet"])
    if check["sheet"] is not None and not tables:
        return _missing_table(check["sheet"])
    subject = next((t for t in tables if resolve(t, check["column"]) is not None), None)
    if subject is None:
        return _no_column(check["column"])
    subject_col = resolve(subject, check["column"])
    assert subject_col is not None
    if (bad := _number_column(subject_col)) is not None:
        return bad
    if subject.truncated:
        return _truncated(subject)

    found = _find_controls(check, file)
    control_file = file
    if found is None:
        for other in same_day():
            found = _find_controls(check, other)
            if found is not None:
                control_file = other
                break
    if found is None:
        return couldnt(
            f"No rows named like “{check['pattern']}” in this file or in another file from the"
            " same experiment and day."
        )
    table, col, rows, matched = found
    readings = [(i, v) for i in rows if (v := _number(col.values[i])) is not None]
    if not readings:
        return couldnt(f"The “{check['pattern']}” rows have no numbers in “{col.label}”.")
    r = check["range"]
    if check["use"] == "mean":
        observed = tidy(sum(v for _, v in readings) / len(readings))
    else:
        outside = [v for _, v in readings if not holds(r, tidy(v))]
        pool = outside or [v for _, v in readings]
        observed = tidy(max(pool, key=lambda v: distance(r, v)))
    control_cells = Cells(
        control_file.sha256,
        table.name,
        tuple(sorted(matched | {col.id}, key=lambda c: (len(c), c))),
        tuple(i for i, _ in readings),
    )
    # What the controls vouch for: this file's other readings in the same column.
    own = control_file is file and table.name == subject.name
    skip = set(rows) if own else set()
    judged_rows = tuple(
        i
        for i in range(subject.rows)
        if i not in skip and _number(subject_col.values[i]) is not None
    )
    source = Cells(file.sha256, subject.name, (subject_col.id,), judged_rows or control_cells.rows)
    return judged(check, observed, check["unit"] or col.unit, source, control_cells)


def evaluate(
    check: dict[str, Any], file: FileTables, same_day: Callable[[], Iterable[FileTables]]
) -> Result:
    match check["kind"]:
        case "curve_fit":
            return curve_fit(check, file)
        case "peak":
            return peak(check, file)
        case "value":
            return value(check, file)
        case "control":
            return control(check, file, same_day)
    raise ValueError(f"unknown check kind {check['kind']!r}")


def lazily(load: Callable[[], Iterable[FileTables]]) -> Callable[[], Iterator[FileTables]]:
    """Reads the same day's files once, and only when a control check needs them."""
    cache: list[FileTables] | None = None

    def get() -> Iterator[FileTables]:
        nonlocal cache
        if cache is None:
            cache = list(load())
        return iter(cache)

    return get
