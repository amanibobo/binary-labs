"""Full tables from spreadsheets and CSV/TSV files, for charts (decisions.md, "data sheet to
chart"). Extraction keeps only a sheet's first rows for search; this keeps every table up to a
cell budget, column by column, with the header found, units read and each column typed.

The output is the JSON the chart builder reads (apps/web/src/lib/data-tables.ts mirrors it):

    {"version": 1, "cellLimit": 200000, "tables": [
      {"name": "Standards", "sheet": "Standards", "notes": ["Read on: Synergy H1"],
       "rows": 8, "truncated": false, "rowsInFile": null,
       "columns": [{"id": "A", "name": "BSA", "unit": "µg/mL", "kind": "number",
                    "values": [0, 125, ...], "invalid": 0}, ...]}]}
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, Literal

from openpyxl.utils import get_column_letter, range_boundaries

from bl_worker.extract import UNIT_RE, decode_text

VERSION = 1
# One file's tables keep at most this many cells: about 1.5 MB of JSON (0.64 MB gzipped) for
# 3-decimal numbers, parsed in about 0.3 s, and about a second to send on 5 Mbps bench Wi-Fi.
# A 2 h kinetic read of a 96-well plate (24k cells), a full spectrum scan of one (38k) or an
# AKTA run with eight curves (48k) all fit; past it the chart is drawn from the first rows and
# says so.
CELL_LIMIT = 200_000
MAX_SHEETS = 32
MAX_COLUMNS = 512
MAX_TEXT = 200
MAX_NOTES = 20

Kind = Literal["number", "text"]
Raw = str | int | float | bool | datetime | date | time | timedelta | None


class TableFailed(Exception):
    """The file's bytes can't be read as a table; recorded, never fails the file."""


@dataclass(frozen=True)
class Column:
    id: str
    name: str
    unit: str | None
    kind: Kind
    values: list[Any]
    invalid: int


@dataclass(frozen=True)
class Table:
    name: str
    sheet: str
    notes: list[str]
    rows: int
    truncated: bool
    rows_in_file: int | None
    columns: list[Column]


@dataclass(frozen=True)
class Parsed:
    tables: list[Table]

    def to_json(self) -> bytes:
        return json.dumps(
            {
                "version": VERSION,
                "cellLimit": CELL_LIMIT,
                "tables": [
                    {
                        "name": t.name,
                        "sheet": t.sheet,
                        "notes": t.notes,
                        "rows": t.rows,
                        "truncated": t.truncated,
                        "rowsInFile": t.rows_in_file,
                        "columns": [
                            {
                                "id": c.id,
                                "name": c.name,
                                "unit": c.unit,
                                "kind": c.kind,
                                "values": c.values,
                                "invalid": c.invalid,
                            }
                            for c in t.columns
                        ],
                    }
                    for t in self.tables
                ],
            },
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()


# A cell as read: its number when it is one, and its text.
@dataclass(frozen=True)
class Cell:
    text: str
    number: float | None = None
    # Seconds, for h:mm:ss text and Excel times; the column picks its unit later.
    duration: bool = False

    @property
    def blank(self) -> bool:
        return self.text == "" and self.number is None


BLANK = Cell("")


@dataclass
class Sheet:
    name: str
    rows: list[list[Cell]] = field(default_factory=list)
    # More rows followed the ones read, and how many when that's known.
    cut: bool = False
    unread: int | None = None


def parse(data: bytes) -> Parsed:
    try:
        sheets = _xlsx(data) if data[:2] == b"PK" else [_csv(data)]
        tables = [t for sheet in sheets for t in _tables(sheet)]
    except TableFailed:
        raise
    except Exception as e:
        raise TableFailed(f"{type(e).__name__}: {e}") from e
    return Parsed(tables)


# Numbers as instruments write them. Decimal commas only where the separator isn't a comma.
_NUMBER = re.compile(r"[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?")
_THOUSANDS = re.compile(r"[-+]?\d{1,3}(,\d{3})+(\.\d+)?")
_DECIMAL_COMMA = re.compile(r"[-+]?\d*,\d+([eE][-+]?\d+)?")
_DURATION = re.compile(r"(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)")


def text_cell(raw: str, *, decimal_comma: bool) -> Cell:
    text = raw.strip()[:MAX_TEXT]
    if text == "":
        return BLANK
    if _NUMBER.fullmatch(text):
        return Cell(text, float(text))
    if decimal_comma and _DECIMAL_COMMA.fullmatch(text):
        return Cell(text, float(text.replace(",", ".")))
    if not decimal_comma and _THOUSANDS.fullmatch(text):
        return Cell(text, float(text.replace(",", "")))
    if m := _DURATION.fullmatch(text):
        return Cell(text, int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]), duration=True)
    return Cell(text)


def value_cell(raw: Raw) -> Cell:
    match raw:
        case None:
            return BLANK
        case bool():
            return Cell("TRUE" if raw else "FALSE")
        case int() | float():
            if isinstance(raw, float) and not math.isfinite(raw):
                return Cell(str(raw))
            return Cell(_number_text(float(raw)), float(raw))
        case datetime() | date():
            return Cell(raw.isoformat())
        case time():
            seconds = raw.hour * 3600 + raw.minute * 60 + raw.second + raw.microsecond / 1e6
            return Cell(raw.isoformat(), seconds, duration=True)
        case timedelta():
            return Cell(str(raw), raw.total_seconds(), duration=True)
        case str():
            return text_cell(raw, decimal_comma=False)
    return Cell(str(raw)[:MAX_TEXT])


def _number_text(x: float) -> str:
    return str(int(x)) if x.is_integer() and abs(x) < 1e15 else repr(x)


def _trim(row: list[Cell]) -> list[Cell]:
    end = len(row)
    while end and row[end - 1].blank:
        end -= 1
    return row[: min(end, MAX_COLUMNS)]


def _csv(data: bytes) -> Sheet:
    text = decode_text(data)
    sample = text[:16384]
    try:
        dialect: Any = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel_tab if sample.count("\t") > sample.count(",") else csv.excel
    delimiter = getattr(dialect, "delimiter", ",")
    decimal_comma = delimiter != "," and len(re.findall(r"\d,\d", sample)) > len(
        re.findall(r"\d\.\d", sample)
    )
    sheet = Sheet("")
    cells = 0
    for row in csv.reader(io.StringIO(text), dialect):
        if cells >= CELL_LIMIT:
            if any(c.strip() for c in row):
                sheet.cut = True
                sheet.unread = (sheet.unread or 0) + 1
            continue
        cooked = _trim([text_cell(c, decimal_comma=decimal_comma) for c in row])
        sheet.rows.append(cooked)
        cells += len(cooked)
    return sheet


def _xlsx(data: bytes) -> list[Sheet]:
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        worksheets = wb.worksheets[:MAX_SHEETS]
        shares = _shares([_declared_cells(ws) for ws in worksheets])
        return [_read_sheet(wb, ws, share) for ws, share in zip(worksheets, shares, strict=True)]
    finally:
        wb.close()


def _declared_cells(ws: Any) -> int:
    rows, cols = ws.max_row, ws.max_column
    if rows is None or cols is None:
        return CELL_LIMIT
    return rows * min(cols, MAX_COLUMNS)


def _shares(sizes: list[int]) -> list[int]:
    """Splits the cell budget so small sheets keep everything and big ones share the rest."""
    shares = [0] * len(sizes)
    left = CELL_LIMIT
    order = sorted(range(len(sizes)), key=lambda i: sizes[i])
    for n, i in enumerate(order):
        shares[i] = min(sizes[i], left // (len(sizes) - n))
        left -= shares[i]
    return shares


def _read_sheet(wb: Any, ws: Any, share: int) -> Sheet:
    merges = _merges(wb, ws)
    sheet = Sheet(ws.title)
    cells = 0
    for r, values in enumerate(ws.iter_rows(values_only=True), start=1):
        if cells >= share:
            sheet.cut = True
            # The sheet declares its last row; trailing blank rows may be counted in it.
            if ws.max_row is not None:
                sheet.unread = max(0, ws.max_row - r + 1)
            break
        row = [value_cell(v) for v in values[:MAX_COLUMNS]]
        for top, left, bottom, right, value in merges:
            if top <= r <= bottom:
                while len(row) < right:
                    row.append(BLANK)
                for c in range(left, right + 1):
                    row[c - 1] = value
        cooked = _trim(row)
        sheet.rows.append(cooked)
        cells += len(cooked)
    return sheet


_MERGE = re.compile(rb'<(?:\w+:)?mergeCell\s+ref="([A-Z]+\d+:[A-Z]+\d+)"')


def _merges(wb: Any, ws: Any) -> list[tuple[int, int, int, int, Cell]]:
    """Merged ranges, each with its top-left value: read-only sheets don't report merges, so
    they're read from the end of the sheet's XML. A merge means every cell holds that value."""
    path = getattr(ws, "_worksheet_path", None)
    if path is None:
        return []
    refs: list[bytes] = []
    with wb._archive.open(path) as src:
        tail = b""
        while chunk := src.read(1 << 20):
            buf = tail + chunk
            refs += _MERGE.findall(buf)
            # Keep enough to catch a tag split across reads, without matching it twice.
            last = buf.rfind(b"<")
            tail = buf[last:] if last >= 0 and b">" not in buf[last:] else b""
    if not refs:
        return []
    bounds = [range_boundaries(ref.decode()) for ref in dict.fromkeys(refs)]
    corners = {(top, left) for left, top, _, _ in bounds}
    values: dict[tuple[int, int], Cell] = {}
    for r, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if r > max(top for top, _ in corners):
            break
        for top, left in corners:
            if top == r and left <= len(row):
                values[(top, left)] = value_cell(row[left - 1])
    return [
        (top, left, bottom, right, values.get((top, left), BLANK))
        for left, top, right, bottom in bounds
        if top is not None and left is not None
    ]


def _filled(row: list[Cell]) -> int:
    return sum(1 for c in row if not c.blank)


def _numbers(row: list[Cell]) -> int:
    return sum(1 for c in row if c.number is not None)


def _texty(row: list[Cell]) -> bool:
    filled = _filled(row)
    return filled > 0 and _numbers(row) * 2 < filled


def _is_data(row: list[Cell]) -> bool:
    return _numbers(row) > 0


def _blocks(rows: list[list[Cell]]) -> list[list[list[Cell]]]:
    blocks: list[list[list[Cell]]] = []
    current: list[list[Cell]] = []
    for row in rows:
        if _filled(row) == 0:
            if current:
                blocks.append(current)
            current = []
        else:
            current.append(row)
    if current:
        blocks.append(current)
    return blocks


@dataclass(frozen=True)
class _Header:
    at: int  # index in the block of the header row
    rows: int  # header rows: 0 (none), 1, or 2 with a units or sub-name row


def _find_header(block: list[list[Cell]]) -> _Header | None:
    width = max(_filled(row) for row in block)
    for r in range(len(block) - 1):
        row = block[r]
        nxt = block[r + 1]
        # A cross-tab (a plate grid): a blank corner, labels across, labels down the side.
        corner = r == 0 and row[0].blank and _filled(row) >= 2
        if corner and nxt and not nxt[0].blank and nxt[0].number is None and _is_data(nxt):
            return _Header(r, 1)
        if _filled(row) < 2 or not _texty(row) or _filled(row) * 2 < width:
            continue
        if _is_data(nxt) and _filled(nxt) * 2 >= _filled(row):
            return _Header(r, 1)
        if r + 2 < len(block) and _texty(nxt) and _is_data(block[r + 2]):
            return _Header(r, 2)
    if len(block) >= 2 and all(_is_data(row) for row in block):
        return _Header(0, 0)
    return None


def _is_body(rows: list[list[Cell]]) -> bool:
    data = sum(1 for row in rows if _is_data(row))
    return data >= 2 and data * 3 >= len(rows) * 2


def _note(row: list[Cell]) -> str:
    texts = [c.text for c in row if not c.blank]
    # A merged title fills every cell it spans with the same text.
    texts = [t for i, t in enumerate(texts) if i == 0 or t != texts[i - 1]]
    if len(texts) == 2:
        return f"{texts[0].rstrip(':').strip()}: {texts[1]}"[:MAX_TEXT]
    return " ".join(texts)[:MAX_TEXT]


def _tables(sheet: Sheet) -> Iterator[Table]:
    blocks = _blocks(sheet.rows)
    notes: list[str] = []
    found: list[tuple[list[list[Cell]], list[list[Cell]], list[str]]] = []
    i = 0
    while i < len(blocks):
        block = blocks[i]
        header = _find_header(block)
        body = block[header.at + header.rows :] if header else []
        if header is None or not _is_body(body):
            notes += [_note(row) for row in block]
            i += 1
            continue
        heads = block[header.at : header.at + header.rows]
        notes += [_note(row) for row in block[: header.at]]
        width = max(len(heads[0]) if heads else 0, max(len(r) for r in body))
        # Data that carries on after a blank row belongs to the same table.
        while i + 1 < len(blocks) and _continues(blocks[i + 1], width):
            i += 1
            body += blocks[i]
        found.append((heads, body, notes[-MAX_NOTES:]))
        notes = []
        i += 1
    for n, (heads, body, table_notes) in enumerate(found):
        cut = sheet.cut and n == len(found) - 1
        rows_in_file = len(body) + sheet.unread if cut and sheet.unread is not None else None
        yield _build(_name(sheet.name, n), heads, body, table_notes, cut, rows_in_file, sheet.name)


def _continues(block: list[list[Cell]], width: int) -> bool:
    first = block[0]
    headed = _find_header(block) not in (None, _Header(0, 0))
    return _is_data(first) and len(first) * 2 >= width and not headed


def _name(sheet: str, n: int) -> str:
    """CSV tables are "Table 1", "Table 2"; a sheet's are "Plate", "Plate (2)"."""
    if not sheet:
        return f"Table {n + 1}"
    return sheet if n == 0 else f"{sheet} ({n + 1})"


_UNIT_WORDS = {
    "ml", "mL", "l", "L", "µl", "µL", "ul", "uL", "nl", "min", "s", "sec", "h", "hr", "ms",
    "mAU", "AU", "OD", "nm", "mm", "cm", "µm", "um", "mS/cm", "µS/cm", "mM", "µM", "uM", "nM",
    "pM", "mg", "µg", "ug", "ng", "g", "kg", "mg/mL", "mg/ml", "µg/mL", "ug/mL", "ug/ml",
    "ng/mL", "g/L", "MPa", "bar", "psi", "rpm", "°C", "K", "%", "mV", "V", "mA", "kDa", "Da",
    "RFU", "RLU", "CV", "cv", "pH",
}  # fmt: skip


def _is_unit(text: str) -> bool:
    inner = text.strip()
    if inner.startswith("(") and inner.endswith(")"):
        inner = inner[1:-1].strip()
    return inner in _UNIT_WORDS or (
        len(inner) <= 12 and any(ch in inner for ch in "/%°µ") and not _NUMBER.fullmatch(inner)
    )


def _split_unit(text: str) -> tuple[str, str | None]:
    if m := UNIT_RE.search(text):
        return text[: m.start()].strip(), m.group(1).strip()
    return text.strip(), None


def _header_names(heads: list[list[Cell]], width: int) -> list[tuple[str, str | None]]:
    def at(row: list[Cell], c: int) -> str:
        return row[c].text if c < len(row) else ""

    top = [at(heads[0], c) for c in range(width)] if heads else [""] * width
    sub = [at(heads[1], c) for c in range(width)] if len(heads) > 1 else [""] * width
    # Over a units or sub-name row, a name written once covers the columns to its right.
    if len(heads) > 1:
        for c in range(1, width):
            if top[c] == "" and sub[c] != "":
                top[c] = top[c - 1]
    out = []
    for c in range(width):
        base, unit = _split_unit(top[c])
        s = sub[c].strip()
        if s and s != top[c]:
            if _is_unit(s):
                unit = s.strip("()").strip()
            else:
                s_base, s_unit = _split_unit(s)
                base = f"{base} {s_base}".strip()
                unit = s_unit or unit
        out.append((base, unit))
    return out


def _build(
    name: str,
    heads: list[list[Cell]],
    body: list[list[Cell]],
    notes: list[str],
    truncated: bool,
    rows_in_file: int | None,
    sheet: str,
) -> Table:
    width = max([len(r) for r in body] + [len(h) for h in heads])
    names = _header_names(heads, width)
    columns = []
    for c in range(width):
        cells = [row[c] if c < len(row) else BLANK for row in body]
        header, unit = names[c]
        if header == "" and all(cell.blank for cell in cells):
            continue
        letter = get_column_letter(c + 1)
        columns.append(_column(letter, header or f"Column {letter}", unit, cells))
    return Table(name, sheet, notes, len(body), truncated, rows_in_file, columns)


def _column(letter: str, name: str, unit: str | None, cells: list[Cell]) -> Column:
    filled = [c for c in cells if not c.blank]
    numbers = [c for c in filled if c.number is not None]
    if numbers and len(numbers) * 2 > len(filled):
        durations = sum(1 for c in numbers if c.duration)
        scale = 1.0
        if durations * 2 > len(numbers):
            unit, scale = _duration_unit(max(c.number or 0 for c in numbers))
        values = [_compact(c.number / scale) if c.number is not None else None for c in cells]
        return Column(letter, name, unit, "number", values, len(filled) - len(numbers))
    texts = [c.text if not c.blank else None for c in cells]
    return Column(letter, name, None, "text", texts, 0)


def _duration_unit(longest: float) -> tuple[str, float]:
    if longest >= 2 * 3600:
        return "h", 3600.0
    if longest >= 2 * 60:
        return "min", 60.0
    return "s", 1.0


def _compact(x: float) -> float | int | None:
    if not math.isfinite(x):
        return None
    if x.is_integer() and abs(x) < 1e15:
        return int(x)
    return float(f"{x:.10g}")
