import json
from pathlib import Path

import pytest

from bl_worker import samples, tables

FIXTURES = Path(__file__).parent / "fixtures" / "tables"


def parse_file(name: str) -> list[tables.Table]:
    return tables.parse((FIXTURES / name).read_bytes()).tables


def column(table: tables.Table, letter: str) -> tables.Column:
    return next(c for c in table.columns if c.id == letter)


def test_plate_reader_header_found_under_the_preamble_with_times_and_overflows():
    [table] = parse_file("plate7_A420.csv")
    assert table.rows == 31
    assert "Reader Type: Synergy H1" in table.notes and "Read 1:420" in table.notes
    time = column(table, "A")
    # h:mm:ss over half an hour reads as minutes.
    assert (time.name, time.unit, time.kind) == ("Time", "min", "number")
    assert time.values[:3] == [0, 1, 2] and time.values[-1] == 30
    assert [c.name for c in table.columns[2:5]] == ["A1", "A2", "A3"]
    assert len(table.columns) == 98
    # Saturated reads are blanks in a number column, and counted.
    h12 = column(table, "CT")
    assert (h12.name, h12.kind, h12.invalid) == ("H12", "number", 5)
    assert h12.values[-5:] == [None] * 5 and isinstance(h12.values[25], float)


def test_akta_utf16_two_row_header_gives_names_units_and_trailing_blanks():
    [table] = parse_file("SEC_trace_141026.csv")
    assert table.notes == ["Chrom.1"]
    named = [(c.id, c.name, c.unit, c.kind) for c in table.columns]
    assert named == [
        ("A", "UV 1_280", "ml", "number"),
        ("B", "UV 1_280", "mAU", "number"),
        ("C", "UV 2_260", "ml", "number"),
        ("D", "UV 2_260", "mAU", "number"),
        ("E", "Cond", "ml", "number"),
        ("F", "Cond", "mS/cm", "number"),
        ("G", "Fraction", "ml", "number"),
        ("H", "Fraction", None, "text"),
    ]
    assert table.rows == 961
    cond = column(table, "F")
    assert sum(v is not None for v in cond.values) == 241 and cond.invalid == 0
    assert column(table, "H").values[:2] == ["A1", "A2"]


def test_bradford_workbook_every_sheet_with_merged_headers():
    standards, samples_sheet, plate = parse_file("Bradford_2026-10-30.xlsx")
    assert [t.name for t in (standards, samples_sheet, plate)] == ["Standards", "Samples", "Plate"]
    assert standards.notes[0] == "Bradford standard curve, BSA in PBS"
    assert [(c.name, c.unit) for c in standards.columns] == [
        ("BSA", "µg/mL"),
        ("A595 Rep 1", "AU"),
        ("A595 Rep 2", "AU"),
        ("A595 Rep 3", "AU"),
        ("Mean", "AU"),
        ("SD", "AU"),
    ]
    assert column(standards, "A").values == [0, 125, 250, 500, 750, 1000, 1500, 2000]
    assert column(samples_sheet, "A").kind == "text"
    assert column(samples_sheet, "D").unit == "µg/mL"
    # A plate grid: a blank corner, column numbers across, row letters down.
    assert [c.name for c in plate.columns[:3]] == ["Column A", "1", "2"]
    assert column(plate, "A").values == list("ABCDEFGH")


def test_numbers_in_text_and_text_in_numbers():
    data = (
        b"Sample,Abs (AU),Note,Count\n"
        b'S1,0.12,ok,"1,204"\n'
        b'S2,n/a,ok,"2,310"\n'
        b"S3,1.2E-02,4,\n"
        b"S4,-.5,redo,18\n"
    )
    [table] = tables.parse(data).tables
    sample, absorbance, note, count = table.columns
    assert sample.kind == "text" and note.kind == "text"
    assert note.values == ["ok", "ok", "4", "redo"]
    assert (absorbance.name, absorbance.unit, absorbance.invalid) == ("Abs", "AU", 1)
    assert absorbance.values == [0.12, None, 0.012, -0.5]
    assert count.values == [1204, 2310, None, 18]


def test_decimal_commas_with_semicolons():
    data = b"Zeit (s);Extinktion\n0;0,112\n30;0,245\n60;1,05\n"
    [table] = tables.parse(data).tables
    assert table.columns[1].values == [0.112, 0.245, 1.05]
    assert table.columns[0].unit == "s"


def test_two_tables_on_one_sheet_and_data_across_a_blank_row():
    data = samples.csv_text(
        [
            ["Run 1"],
            ["Time", "Signal"],
            ["0", "1.0"],
            ["1", "1.5"],
            [],
            ["2", "1.7"],
            [],
            ["Run 2"],
            ["Time", "Signal", "Temp"],
            ["0", "2.0", "25"],
            ["1", "2.4", "25"],
        ]
    )
    first, second = tables.parse(data).tables
    assert (first.name, first.rows, first.notes) == ("Table 1", 3, ["Run 1"])
    assert first.columns[1].values == [1.0, 1.5, 1.7]
    assert (second.name, second.notes, len(second.columns)) == ("Table 2", ["Run 2"], 3)


def test_a_sheet_of_numbers_with_no_header_gets_letter_names():
    [table] = tables.parse(samples.csv_text([["1", "2"], ["3", "4"]])).tables
    assert [c.name for c in table.columns] == ["Column A", "Column B"]
    assert table.columns[0].values == [1, 3]


def test_text_with_no_table_has_no_tables():
    data = samples.xlsx({"Notes": [["batch 3 rerun"], ["see notebook p. 41"]]})
    assert tables.parse(data).tables == []


def test_the_cell_limit_keeps_the_first_rows_and_counts_the_rest(monkeypatch):
    monkeypatch.setattr(tables, "CELL_LIMIT", 100)
    rows = [["x", "y"]] + [[str(i), str(i * 2)] for i in range(500)]
    [table] = tables.parse(samples.csv_text(rows)).tables
    assert table.truncated and table.rows == 49
    assert table.rows_in_file == 500
    assert table.columns[1].values[-1] == 96


def test_the_cell_limit_is_shared_so_small_sheets_stay_whole(monkeypatch):
    monkeypatch.setattr(tables, "CELL_LIMIT", 300)
    big = [["t", "v"]] + [[i, i] for i in range(1000)]
    small = [["conc", "abs"]] + [[i, i / 10] for i in range(8)]
    data = samples.xlsx({"Raw": big, "Curve": small})
    raw, curve = tables.parse(data).tables
    assert (curve.rows, curve.truncated) == (8, False)
    assert raw.truncated and raw.rows < 1000 and raw.rows_in_file == 1000
    assert tables._shares([2002, 18]) == [282, 18]


def test_json_is_compact_and_round_trips():
    data = samples.csv_text([["t (s)", "a"], ["0", "0.5"], ["1", ""]])
    doc = json.loads(tables.parse(data).to_json())
    assert doc["version"] == tables.VERSION and doc["cellLimit"] == tables.CELL_LIMIT
    [table] = doc["tables"]
    assert table["columns"][1] == {
        "id": "B",
        "name": "a",
        "unit": None,
        "kind": "number",
        "values": [0.5, None],
        "invalid": 0,
    }


def test_garbage_is_a_table_failure():
    with pytest.raises(tables.TableFailed):
        tables.parse(b"PK\x03\x04 not really a workbook")
