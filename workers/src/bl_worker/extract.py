from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from bl_worker.domain import ExtractionKind, FileKind

MAX_ROWS = 50
UNIT_RE = re.compile(r"[\(\[]\s*([^()\[\]]{1,20}?)\s*[\)\]]\s*$")


@dataclass(frozen=True)
class Extracted:
    kind: ExtractionKind
    content: str
    meta: dict[str, Any] = field(default_factory=dict)


class ExtractionFailed(Exception):
    """The file's bytes can't be parsed; the location fails, not the job."""


class Extractor(Protocol):
    name: str
    version: int

    def extract(self, data: bytes) -> Extracted: ...


def _clean(text: str) -> str:
    # Postgres text can't hold NUL.
    return text.replace("\x00", "")


class PdfExtractor:
    name = "pdfplumber"
    version = 1

    def extract(self, data: bytes) -> Extracted:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(data)) as pdf:
            pages = [page.extract_text() or "" for page in pdf.pages]
        return Extracted(
            ExtractionKind.TEXT, _clean("\n\n".join(pages).strip()), {"pages": len(pages)}
        )


def _cell(value: object) -> str:
    return "" if value is None else str(value).strip()


def _table_text(sheet: str, rows: list[list[str]]) -> tuple[str, dict[str, Any]]:
    """Sheet name, header row, units parsed from headers, then the first MAX_ROWS rows."""
    rows = [r for r in rows if any(r)]
    if not rows:
        return f"Sheet: {sheet}\n(empty)", {"name": sheet, "header": [], "units": {}, "rows": 0}
    width = max(sum(1 for c in r if c) for r in rows)
    # Instrument exports put key/value preamble lines above the header; the header is the
    # first row as wide as the table.
    header_at = next(i for i, r in enumerate(rows) if sum(1 for c in r if c) >= width)
    header = rows[header_at]
    units = {h[: m.start()].strip(): m.group(1) for h in header if (m := UNIT_RE.search(h))}
    body = rows[header_at + 1 : header_at + 1 + MAX_ROWS]
    lines = [f"Sheet: {sheet}"]
    lines += [" | ".join(c for c in r if c) for r in rows[:header_at]]
    lines.append("Columns: " + " | ".join(header))
    if units:
        lines.append("Units: " + "; ".join(f"{h}: {u}" for h, u in units.items()))
    lines += [" | ".join(r) for r in body]
    meta = {"name": sheet, "header": header, "units": units, "rows": len(body)}
    return "\n".join(lines), meta


class SpreadsheetExtractor:
    name = "spreadsheet"
    version = 1

    def extract(self, data: bytes) -> Extracted:
        sheets = self._xlsx(data) if data[:2] == b"PK" else self._csv(data)
        parts = [_table_text(name, rows) for name, rows in sheets]
        return Extracted(
            ExtractionKind.TABLE,
            _clean("\n\n".join(text for text, _ in parts)),
            {"sheets": [meta for _, meta in parts]},
        )

    def _xlsx(self, data: bytes) -> list[tuple[str, list[list[str]]]]:
        import openpyxl

        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        try:
            out = []
            for ws in wb.worksheets:
                rows = []
                for row in ws.iter_rows(values_only=True):
                    rows.append([_cell(v) for v in row])
                    if len(rows) > MAX_ROWS + 20:
                        break
                out.append((ws.title, rows))
            return out
        finally:
            wb.close()

    def _csv(self, data: bytes) -> list[tuple[str, list[list[str]]]]:
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("latin-1")
        sample = text[:8192]
        try:
            dialect: Any = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        rows = []
        for row in csv.reader(io.StringIO(text), dialect):
            rows.append([c.strip() for c in row])
            if len(rows) > MAX_ROWS + 20:
                break
        return [("csv", rows)]


class DocxExtractor:
    name = "python-docx"
    version = 1

    def extract(self, data: bytes) -> Extracted:
        import docx

        doc = docx.Document(io.BytesIO(data))
        parts = [p.text for p in doc.paragraphs if p.text.strip()]
        for table in doc.tables:
            for row in table.rows:
                parts.append(" | ".join(c.text.strip() for c in row.cells))
        return Extracted(ExtractionKind.TEXT, _clean("\n".join(parts)), {})


class TextExtractor:
    name = "utf8"
    version = 1

    def extract(self, data: bytes) -> Extracted:
        text = data.decode("utf-8", errors="replace")
        return Extracted(ExtractionKind.TEXT, _clean(text), {})


EXIF_FIELDS = {
    "DateTimeOriginal": "Taken",
    "DateTime": "Modified",
    "Make": "Make",
    "Model": "Camera",
    "ImageDescription": "Description",
    "Software": "Software",
    "LensModel": "Lens",
}


class ImageMetaExtractor:
    name = "pillow-exif"
    version = 1

    def extract(self, data: bytes) -> Extracted:
        from PIL import ExifTags, Image

        with Image.open(io.BytesIO(data)) as img:
            exif = img.getexif()
            tags: dict[str, str] = {}
            for ifd in (exif, exif.get_ifd(ExifTags.IFD.Exif)):
                for tag_id, value in ifd.items():
                    tag = ExifTags.TAGS.get(tag_id)
                    if tag in EXIF_FIELDS and not isinstance(value, bytes):
                        tags[tag] = _clean(str(value).strip())
            size = img.size
        lines = [f"{EXIF_FIELDS[t]}: {v}" for t, v in tags.items() if v]
        lines.append(f"Size: {size[0]}x{size[1]}")
        return Extracted(
            ExtractionKind.IMAGE_META,
            "\n".join(lines),
            {"exif": tags, "width": size[0], "height": size[1]},
        )


EXTRACTORS: dict[FileKind, Extractor] = {
    FileKind.PDF: PdfExtractor(),
    FileKind.SPREADSHEET: SpreadsheetExtractor(),
    FileKind.DOCUMENT: DocxExtractor(),
    FileKind.TEXT: TextExtractor(),
    FileKind.IMAGE: ImageMetaExtractor(),
}


def run_extractor(extractor: Extractor, data: bytes) -> Extracted:
    try:
        return extractor.extract(data)
    except Exception as e:
        raise ExtractionFailed(f"{extractor.name}: {type(e).__name__}: {e}") from e
