"""Dates and date-times in table cells, for a chart's time axis (decisions.md, "dates along x").

A cell is read into its parts first. Whether 3/11/2026 is the 3rd of November or March the
11th is decided for the whole column, from every date in it, and the column's note says which
reading was taken. Values become milliseconds since 1970 of the wall-clock time as written, so
a chart prints what the instrument printed and never shifts with the reader's time zone. A
column that writes UTC offsets is converted to UTC, and its note says so.
"""

from __future__ import annotations

import calendar
import itertools
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal

MONTHS = {
    m.lower(): i
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1
    )
}

_TIME = (
    r"(?:[T ]+(?P<h>\d{1,2}):(?P<mi>\d{2})(?::(?P<s>\d{2})(?:[.,](?P<f>\d{1,6}))?)?"
    r"\s*(?P<ampm>[AaPp]\.?[Mm]\.?)?\s*(?P<tz>Z|UTC|[+-]\d{2}:?\d{2})?)?"
)
_YMD = re.compile(r"(?P<y>\d{4})(?P<sep>[-/.])(?P<a>\d{1,2})(?P=sep)(?P<b>\d{1,2})" + _TIME)
_AB = re.compile(r"(?P<a>\d{1,2})(?P<sep>[-/.])(?P<b>\d{1,2})(?P=sep)(?P<y>\d{4}|\d{2})" + _TIME)
_DAY_MONTH = re.compile(r"(?P<b>\d{1,2})[ -](?P<mon>[A-Za-z]{3,9})\.?,?[ -](?P<y>\d{4})" + _TIME)
_MONTH_DAY = re.compile(r"(?P<mon>[A-Za-z]{3,9})\.? (?P<b>\d{1,2}),? (?P<y>\d{4})" + _TIME)
# Instrument stamps with no separators, like 20261103_174412 or 20261103T174412.
_COMPACT = re.compile(
    r"(?P<y>\d{4})(?P<a>\d{2})(?P<b>\d{2})[T_ -](?P<h>\d{2})(?P<mi>\d{2})(?P<s>\d{2})"
)

Order = Literal["dmy", "mdy"]


@dataclass(frozen=True)
class DateParts:
    year: int
    # Month and day for "ymd"; for "ab" the first two fields, in an order the column decides.
    a: int
    b: int
    form: Literal["ymd", "ab"]
    sep: str
    seconds: float
    has_time: bool
    offset_min: int | None


def _month(name: str) -> int | None:
    return MONTHS.get(name[:3].lower()) if name[:3].lower() in MONTHS else None


def _time(m: re.Match[str]) -> tuple[float, bool, int | None] | None:
    if m.groupdict().get("h") is None:
        return 0.0, False, None
    h, mi = int(m["h"]), int(m["mi"])
    s = int(m["s"] or 0)
    frac = float(f"0.{m['f']}") if m.groupdict().get("f") else 0.0
    ampm = (m.groupdict().get("ampm") or "").lower().replace(".", "")
    if ampm:
        if not 1 <= h <= 12:
            return None
        h = h % 12 + (12 if ampm == "pm" else 0)
    if h > 23 or mi > 59 or s > 59:
        return None
    offset = None
    tz = m.groupdict().get("tz")
    if tz in ("Z", "UTC"):
        offset = 0
    elif tz:
        digits = tz[1:].replace(":", "")
        offset = (int(digits[:2]) * 60 + int(digits[2:])) * (-1 if tz[0] == "-" else 1)
    return h * 3600 + mi * 60 + s + frac, True, offset


def _year(text: str) -> int:
    y = int(text)
    if len(text) == 2:
        return 2000 + y if y < 70 else 1900 + y
    return y


def parse(text: str) -> DateParts | None:
    """A date or date-time as written in a cell, or None."""
    for pattern, form in ((_YMD, "ymd"), (_COMPACT, "ymd"), (_AB, "ab")):
        if m := pattern.fullmatch(text):
            t = _time(m)
            if t is None:
                return None
            sep = m.groupdict().get("sep") or ""
            parts = DateParts(_year(m["y"]), int(m["a"]), int(m["b"]), form, sep, *t)  # type: ignore[arg-type]
            return parts if _possible(parts) else None
    for pattern in (_DAY_MONTH, _MONTH_DAY):
        if m := pattern.fullmatch(text):
            month = _month(m["mon"])
            t = _time(m)
            if month is None or t is None:
                return None
            parts = DateParts(int(m["y"]), month, int(m["b"]), "ymd", " ", *t)
            return parts if _possible(parts) else None
    return None


def from_value(value: datetime | date) -> DateParts:
    """A date an Excel cell holds as a date (openpyxl reads it from the cell's format)."""
    if isinstance(value, datetime):
        seconds = value.hour * 3600 + value.minute * 60 + value.second + value.microsecond / 1e6
        offset = None
        if value.tzinfo is not None and (delta := value.utcoffset()) is not None:
            offset = int(delta.total_seconds() // 60)
        has_time = seconds > 0 or offset is not None
        return DateParts(value.year, value.month, value.day, "ymd", "-", seconds, has_time, offset)
    return DateParts(value.year, value.month, value.day, "ymd", "-", 0.0, False, None)


def _valid(year: int, month: int, day: int) -> bool:
    return 1 <= month <= 12 and 1 <= day <= calendar.monthrange(year, month)[1] and year >= 1000


def _possible(p: DateParts) -> bool:
    if p.form == "ymd":
        return _valid(p.year, p.a, p.b)
    return _valid(p.year, p.b, p.a) or _valid(p.year, p.a, p.b)


def _fields(p: DateParts, order: Order) -> tuple[int, int]:
    """Month and day."""
    if p.form == "ymd":
        return p.a, p.b
    return (p.b, p.a) if order == "dmy" else (p.a, p.b)


def to_ms(p: DateParts, order: Order) -> float | None:
    month, day = _fields(p, order)
    if not _valid(p.year, month, day):
        return None
    days = (date(p.year, month, day) - date(1970, 1, 1)).days
    ms = (days * 86400 + p.seconds - (p.offset_min or 0) * 60) * 1000
    return round(ms, 3)


def _sortedness(parts: list[DateParts], order: Order) -> float:
    """How much of the column runs forward in time when read in this order."""
    ms = [to_ms(p, order) for p in parts]
    pairs = [(x, y) for x, y in itertools.pairwise(ms) if x is not None and y is not None]
    if not pairs:
        return 0.0
    return sum(1 for x, y in pairs if y >= x) / len(pairs)


@dataclass(frozen=True)
class Reading:
    order: Order
    note: str | None
    has_time: bool


def read_column(parts: list[DateParts]) -> Reading | None:
    """The order every day/month date in a column is read in, decided from all of them, and
    what the column's note says about it. None when no single order fits every date."""
    has_time = any(p.has_time for p in parts)
    utc = (
        " Times are in UTC, from the offsets in the file."
        if any(p.offset_min is not None for p in parts)
        else ""
    )
    ab = [p for p in parts if p.form == "ab"]
    if not ab:
        return Reading("mdy", utc.strip() or None, has_time)
    fits_dmy = all(_valid(p.year, p.b, p.a) for p in ab)
    fits_mdy = all(_valid(p.year, p.a, p.b) for p in ab)
    if fits_dmy and not fits_mdy:
        return Reading("dmy", "Read as day/month/year." + utc, has_time)
    if fits_mdy and not fits_dmy:
        return Reading("mdy", "Read as month/day/year." + utc, has_time)
    if not fits_dmy and not fits_mdy:
        return None
    # Either order fits every date. A log runs forward in time, so the order that keeps it in
    # order wins; failing that, slashes are read the US way and dots and dashes the European.
    dmy, mdy = _sortedness(ab, "dmy"), _sortedness(ab, "mdy")
    if dmy != mdy:
        order: Order = "dmy" if dmy > mdy else "mdy"
        why = "it keeps the rows in time order"
    else:
        order = "mdy" if ab[0].sep == "/" else "dmy"
        why = "nothing in the column says which"
    name = "day/month/year" if order == "dmy" else "month/day/year"
    return Reading(order, f"Read as {name}, since {why}. Check a date you know." + utc, has_time)


# Excel counts days from 1899-12-30 (it thinks 1900 was a leap year). 20000 to 80000 is 1954
# to 2119, so a column of plain counts or volumes isn't taken for dates.
EXCEL_EPOCH_DAYS = 25569
EXCEL_SERIAL_RANGE = (20000, 80000)
_DATE_HEADER = re.compile(r"\b(date|time ?stamp|datetime)\b", re.IGNORECASE)


def looks_like_excel_dates(header: str, numbers: list[float]) -> bool:
    lo, hi = EXCEL_SERIAL_RANGE
    return (
        bool(_DATE_HEADER.search(header)) and bool(numbers) and all(lo <= n <= hi for n in numbers)
    )


def excel_ms(serial: float) -> float:
    return round((serial - EXCEL_EPOCH_DAYS) * 86400 * 1000, 3)
