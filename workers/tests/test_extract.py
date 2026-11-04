import pytest

from bl_worker import samples
from bl_worker.domain import ExtractionKind, FileKind
from bl_worker.extract import EXTRACTORS, ExtractionFailed, run_extractor
from bl_worker.filekind import detect
from bl_worker.previews import LONGEST_SIDE, render_preview


def extract(name: str, data: bytes):
    kind, mime = detect(name, data)
    return kind, mime, EXTRACTORS[kind].extract(data)


def test_pdf_text_from_every_page():
    data = samples.pdf(["SDS-PAGE of P450 batch 3", "Lane 2: 40 kDa band"], pages=2)
    kind, mime, out = extract("gel_notes.pdf", data)
    assert (kind, mime, out.kind) == (FileKind.PDF, "application/pdf", ExtractionKind.TEXT)
    assert "SDS-PAGE of P450 batch 3" in out.content and "40 kDa band" in out.content
    assert out.meta == {"pages": 2}


def test_xlsx_sheet_names_header_units_and_first_50_rows():
    rows = [["Sample", "Conc (mg/mL)", "A280 [AU]"]] + [[f"S{i}", i, i / 10] for i in range(80)]
    data = samples.xlsx({"Plate1": rows, "Notes": [["batch 3 rerun"]]})
    kind, _, out = extract("final_v2_REAL.xlsx", data)
    assert kind is FileKind.SPREADSHEET and out.kind is ExtractionKind.TABLE
    assert "Sheet: Plate1" in out.content and "Sheet: Notes" in out.content
    assert "Columns: Sample | Conc (mg/mL) | A280 [AU]" in out.content
    plate = out.meta["sheets"][0]
    assert plate["units"] == {"Conc": "mg/mL", "A280": "AU"}
    assert plate["rows"] == 50
    assert "S49 |" in out.content and "S50 |" not in out.content


def test_plate_reader_csv_finds_the_header_under_the_preamble():
    data = samples.csv_text(
        [
            ["Software Version", "3.11"],
            ["Read", "Absorbance 600"],
            ["Well", "OD600 (AU)", "Time (s)"],
            ["A1", "0.123", "30"],
        ]
    )
    kind, mime, out = extract("plate_export.csv", data)
    assert (kind, mime) == (FileKind.SPREADSHEET, "text/csv")
    sheet = out.meta["sheets"][0]
    assert sheet["header"] == ["Well", "OD600 (AU)", "Time (s)"]
    assert sheet["units"] == {"OD600": "AU", "Time": "s"}
    assert "Software Version | 3.11" in out.content


def test_docx_paragraphs_and_tables():
    data = samples.docx(
        ["Ni-NTA purification", "Equilibrate the column."],
        [["Buffer", "Imidazole"], ["Wash", "20 mM"]],
    )
    kind, _, out = extract("protocol.docx", data)
    assert kind is FileKind.DOCUMENT
    assert out.content.splitlines() == [
        "Ni-NTA purification",
        "Equilibrate the column.",
        "Buffer | Imidazole",
        "Wash | 20 mM",
    ]


def test_text_is_utf8_with_nul_removed():
    kind, _, out = extract("notes.txt", "β-mercaptoethanol 5 µL\x00".encode())
    assert kind is FileKind.TEXT
    assert out.content == "β-mercaptoethanol 5 µL"


def test_jpeg_exif_and_a_640px_webp_preview():
    data = samples.gel_jpeg(seed=4, make="Bio-Rad", model="ChemiDoc", taken="2026:10:14 15:32:01")
    kind, mime, out = extract("IMG_4821.jpg", data)
    assert (kind, mime, out.kind) == (FileKind.IMAGE, "image/jpeg", ExtractionKind.IMAGE_META)
    assert out.meta["exif"] == {
        "Make": "Bio-Rad",
        "Model": "ChemiDoc",
        "DateTimeOriginal": "2026:10:14 15:32:01",
    }
    assert "Taken: 2026:10:14 15:32:01" in out.content
    preview = render_preview(kind, data)
    assert preview is not None and preview.webp[8:12] == b"WEBP"
    assert (preview.width, preview.height) == (LONGEST_SIDE, 480)


def test_pdf_first_page_preview_fits_640():
    preview = render_preview(FileKind.PDF, samples.pdf(["page one"]))
    assert preview is not None and preview.webp[8:12] == b"WEBP"
    assert max(preview.width, preview.height) == LONGEST_SIDE


def test_content_beats_a_wrong_extension():
    assert detect("scan.txt", samples.pdf(["x"]))[0] is FileKind.PDF
    assert detect("photo.dat", samples.gel_jpeg(seed=1))[0] is FileKind.IMAGE
    assert detect("run.fcs", b"FCS3.0\x00\x01binary")[0] is FileKind.OTHER


def test_registry_has_no_extractor_for_other():
    assert FileKind.OTHER not in EXTRACTORS


def test_a_corrupt_file_is_an_extraction_failure_not_a_crash():
    with pytest.raises(ExtractionFailed, match="pdfplumber"):
        run_extractor(EXTRACTORS[FileKind.PDF], b"%PDF-1.4 this is not really a pdf")
