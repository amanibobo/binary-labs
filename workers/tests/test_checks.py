"""The check engine against parsed tables, without a database: every kind of check, what each
reads, and the cases it can't compute."""

import json
import uuid
from pathlib import Path

import pytest

from bl_worker import checks, samples, tables

FIXTURES = Path(__file__).parent / "fixtures" / "tables"


def parsed(name: str) -> checks.FileTables:
    return checks.file_tables(
        name, json.loads(tables.parse((FIXTURES / name).read_bytes()).to_json())
    )


def from_rows(rows: list[list[object]], sha: str = "made") -> checks.FileTables:
    return checks.file_tables(sha, json.loads(tables.parse(samples.csv_text(rows)).to_json()))


def check(kind: str, range_: dict, **fields) -> dict:
    base = {"id": str(uuid.uuid4()), "name": "A check", "kind": kind, "sheet": None, "unit": None}
    return base | {"range": range_} | fields


def at_least(v):
    return {"kind": "at_least", "min": v}


def at_most(v):
    return {"kind": "at_most", "max": v}


def around(t, tol):
    return {"kind": "around", "target": t, "tolerance": tol}


def between(a, b):
    return {"kind": "between", "min": a, "max": b}


def no_others():
    return iter(())


def run(c, file, same_day=no_others):
    return checks.evaluate(c, file, same_day)


CURVE = check("curve_fit", at_least(0.98), x=None, y=None)


def test_a_straight_bradford_curve_passes_and_a_bent_or_short_one_fails():
    good = run(CURVE, parsed("Bradford_2026-11-03.xlsx"))
    assert good.outcome == "passed" and good.observed == pytest.approx(0.9998)
    # The concentration and the mean of the reps were worked out from the names and units.
    assert good.source == checks.Cells(
        "Bradford_2026-11-03.xlsx", "Standards", ("A", "E"), tuple(range(6))
    )

    bent = run(CURVE, parsed("Bradford_2026-10-30.xlsx"))
    assert (bent.outcome, bent.observed) == ("flagged", 0.9418)
    short = run(CURVE, parsed("Bradford_2026-11-04.xlsx"))
    assert (short.outcome, short.observed) == ("flagged", 0.8762)


def test_curve_columns_can_be_named_by_name_by_name_and_unit_or_by_letter():
    file = parsed("Bradford_2026-11-04.xlsx")
    for x, y in [("BSA", "A595 Rep 1"), ("bsa (µg/mL)", "a595 rep 1 (AU)"), ("A", "B")]:
        r = run(check("curve_fit", at_least(0.98), x=x, y=y), file)
        assert r.outcome == "flagged" and r.source.columns == ("A", "B"), (x, y)
    # One named and one worked out.
    r = run(check("curve_fit", at_least(0.98), x="BSA", y=None), file)
    assert r.source.columns == ("A", "E")


def test_a_curve_it_cannot_fit_is_couldnt_check_with_the_reason():
    two = from_rows([["Conc (µg/mL)", "A595"], [0, 0.4], [100, 0.5]])
    assert run(CURVE, two).reason == (
        "Only 2 standards have both a concentration and a reading; a fit needs 3."
    )
    flat = from_rows([["Conc (µg/mL)", "A595"], [0, 0.4], [100, 0.4], [200, 0.4]])
    assert run(CURVE, flat).reason == "The standards don't vary, so there's no line to fit."
    unnamed = from_rows([["p", "q", "r"], [1, 2, 3], [2, 3, 4], [3, 4, 5]])
    assert run(CURVE, unnamed).reason.startswith("Couldn't tell which columns")
    missing = run(
        check("curve_fit", at_least(0.98), x="Dose", y="A595"), parsed("Bradford_2026-11-03.xlsx")
    )
    assert missing.reason == "There's no column called “Dose” in this file."
    sheet = run(
        check("curve_fit", at_least(0.98), x=None, y=None, sheet="Curve"),
        parsed("Bradford_2026-11-03.xlsx"),
    )
    assert sheet.reason == "There's no table called “Curve” in this file."
    text = run(
        check("curve_fit", at_least(0.98), x="Sample", y="A595"), parsed("Bradford_2026-11-03.xlsx")
    )
    assert text.reason == "“Sample” holds text, not numbers."
    for r in (run(CURVE, two), run(CURVE, flat)):
        assert (r.outcome, r.observed, r.source) == ("couldnt", None, None)


def test_a_truncated_table_is_not_checked_on_part_of_its_rows():
    file = parsed("Bradford_2026-11-03.xlsx")
    cut = checks.FileTables(
        file.sha256,
        [checks.Table(t.name, t.rows, True, 90_000, t.columns) for t in file.tables],
    )
    assert run(CURVE, cut).reason == (
        "Only the first 6 of 90,000 rows of “Standards” were read,"
        " so this check can't see them all."
    )


def test_the_peak_of_a_spectrum_and_of_an_elution_trace():
    spectrum = parsed("spectrum_BM3_2026-11-03.csv")
    r = run(check("peak", around(280, 2), x=None, y=None), spectrum)
    assert (r.outcome, r.observed, r.unit) == ("passed", 280.0, "nm")
    assert r.source.columns == ("A", "B") and r.source.rows == (40,)
    off = run(check("peak", around(285, 2), x=None, y=None), spectrum)
    assert (off.outcome, off.observed) == ("flagged", 280.0)

    sec = run(check("peak", between(13.2, 13.6), x=None, y=None), parsed("SEC_trace_141026.csv"))
    assert (sec.outcome, sec.observed, sec.unit) == ("passed", 13.375, "ml")
    # The A260 curve peaks at its nucleic acid contaminant instead.
    a260 = run(check("peak", between(13.2, 13.6), x="C", y="D"), parsed("SEC_trace_141026.csv"))
    assert a260.outcome == "passed"
    few = from_rows([["Wavelength (nm)", "Abs (AU)"], [280, 1], [281, 0.9]])
    assert run(check("peak", around(280, 2), x=None, y=None), few).reason.startswith(
        "Only 2 points"
    )


def test_a_value_is_a_mean_max_min_or_one_cell():
    plate = parsed("plate9_A595_endpoint.csv")
    mean = run(check("value", between(0.1, 1), column="A595", stat="mean", row=None), plate)
    assert mean.outcome == "passed" and mean.source.rows == tuple(range(15))
    high = run(check("value", at_most(0.9), column="A595", stat="max", row=None), plate)
    assert high.outcome == "passed" and len(high.source.rows) == 1
    low = run(check("value", at_least(0.1), column="A595", stat="min", row=None), plate)
    assert (
        low.outcome == "flagged" and plate.tables[0].columns[0].values[low.source.rows[0]] == "A1"
    )

    nano = parsed("nanodrop_2026-11-03.csv")
    ratio = check("value", at_most(0.6), column="260/280", stat="cell", row="bm3 pool")
    r = run(ratio, nano)
    assert (r.outcome, r.observed, r.source.columns, r.source.rows) == (
        "passed",
        0.57,
        ("E",),
        (0,),
    )
    by_number = run(ratio | {"row": "2"}, nano)
    assert (by_number.outcome, by_number.observed) == ("flagged", 0.61)
    assert run(ratio | {"row": "Lysate"}, nano).reason == "There's no row “Lysate” in “Table 1”."
    assert (
        run(ratio | {"column": "Sample ID"}, nano).reason == "“Sample ID” holds text, not numbers."
    )
    empty = from_rows([["Sample", "Ratio"], ["b", 2], ["a", ""], ["c", 1.9], ["d", 2.1]])
    assert run(ratio | {"column": "Ratio", "row": "a"}, empty).reason == (
        "The “Ratio” cell in row “a” is empty."
    )


BLANK = check("control", at_most(0.1), pattern="blank", labelColumn=None, column="A595", use="each")


def test_a_blank_out_of_range_flags_the_plate_with_the_worst_blank():
    plate = parsed("plate8_A595_endpoint.csv")
    r = run(BLANK, plate)
    assert (r.outcome, r.observed) == ("flagged", 0.225)
    # The controls are the three blank rows; what they vouch for is every other reading.
    assert r.control == checks.Cells(plate.sha256, "Table 1", ("B", "C"), (0, 1, 2))
    assert r.source == checks.Cells(plate.sha256, "Table 1", ("C",), tuple(range(3, 15)))
    good = run(BLANK, parsed("plate9_A595_endpoint.csv"))
    assert (good.outcome, good.observed) == ("passed", 0.061)
    mean = run(BLANK | {"use": "mean", "range": at_most(0.21)}, plate)
    assert (mean.outcome, mean.observed) == ("flagged", 0.210667)
    assert run(BLANK | {"labelColumn": "Sample"}, plate).control.columns == ("B", "C")
    assert run(BLANK | {"labelColumn": "Well"}, plate).reason.startswith(
        "No rows named like “blank”"
    )


def test_the_days_controls_can_come_from_another_file():
    readings = from_rows([["Sample", "A595"], ["Lysate", 0.5], ["Wash", 0.3]], sha="samples")
    blanks = from_rows([["Sample", "A595"], ["Blank 1", 0.2], ["Blank 2", 0.04]], sha="blanks")
    r = run(BLANK, readings, lambda: iter([blanks]))
    assert (r.outcome, r.observed) == ("flagged", 0.2)
    assert r.control == checks.Cells("blanks", "Table 1", ("A", "B"), (0, 1))
    assert r.source == checks.Cells("samples", "Table 1", ("B",), (0, 1))
    alone = run(BLANK, readings)
    assert alone.outcome == "couldnt"
    assert alone.reason == (
        "No rows named like “blank” in this file"
        " or in another file from the same experiment and day."
    )
    assert (
        run(BLANK, parsed("plate7_A420.csv")).reason
        == "There's no column called “A595” in this file."
    )


def test_range_edges_hold_like_sql():
    assert checks.holds(at_least(0.98), 0.98) and not checks.holds(at_least(0.98), 0.9799)
    assert checks.holds(around(280, 2), 282) and not checks.holds(around(280, 2), 282.5)
    assert checks.holds(between(1, 2), 1) and checks.holds(between(1, 2), 2)
    assert checks.distance(at_most(0.1), 0.2) == pytest.approx(0.1)


def test_cells_become_half_open_spans():
    assert checks.Cells("s", "t", ("A",), (0, 1, 2, 5, 7, 8)).spans() == [(0, 3), (5, 6), (7, 9)]
