"""Small real files for tests and scripts/make_sample_lab.py. Needs the dev group (fpdf2)."""

from __future__ import annotations

import io
import random

from PIL import Image, ImageDraw


def pdf(lines: list[str], *, pages: int = 1) -> bytes:
    from fpdf import FPDF

    doc = FPDF()
    doc.set_font("helvetica", size=11)
    per_page = max(1, len(lines) // pages)
    for i in range(pages):
        doc.add_page()
        chunk = lines[i * per_page : (i + 1) * per_page] if i < pages - 1 else lines[i * per_page :]
        for line in chunk:
            doc.multi_cell(0, 6, line, new_x="LMARGIN", new_y="NEXT")
    return bytes(doc.output())


def xlsx(sheets: dict[str, list[list[object]]]) -> bytes:
    import openpyxl

    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for row in rows:
            ws.append(row)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def docx(paragraphs: list[str], table: list[list[str]] | None = None) -> bytes:
    import docx as python_docx

    doc = python_docx.Document()
    for i, text in enumerate(paragraphs):
        if i == 0:
            doc.add_heading(text, level=1)
        else:
            doc.add_paragraph(text)
    if table:
        t = doc.add_table(rows=len(table), cols=len(table[0]))
        for r, row in enumerate(table):
            for c, value in enumerate(row):
                t.cell(r, c).text = value
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def csv_text(rows: list[list[object]]) -> bytes:
    return ("\n".join(",".join(str(c) for c in row) for row in rows) + "\n").encode()


def gel_jpeg(
    *,
    seed: int,
    make: str = "Canon",
    model: str = "EOS R6",
    taken: str = "2026:10:14 15:32:01",
    description: str | None = None,
    size: tuple[int, int] = (1200, 900),
) -> bytes:
    """A dark image with lanes of bands, carrying EXIF camera and date tags."""
    rng = random.Random(seed)
    img = Image.new("RGB", size, (18, 18, 22))
    draw = ImageDraw.Draw(img)
    lanes = 10
    lane_w = size[0] // (lanes + 2)
    for lane in range(lanes):
        x = lane_w * (lane + 1)
        for _ in range(rng.randint(3, 7)):
            y = rng.randint(80, size[1] - 80)
            shade = rng.randint(120, 240)
            draw.rectangle([x + 8, y, x + lane_w - 8, y + rng.randint(4, 12)], fill=(shade,) * 3)
    exif = Image.Exif()
    exif[0x010F] = make
    exif[0x0110] = model
    if description:
        exif[0x010E] = description
    exif.get_ifd(0x8769)[0x9003] = taken
    out = io.BytesIO()
    img.save(out, "JPEG", quality=85, exif=exif)
    return out.getvalue()
