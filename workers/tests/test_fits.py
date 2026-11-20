"""The worker's curve fits give the chart's numbers: the same SciPy answers stats.test.ts holds
the TypeScript fits to, and the worked example's IC50 from fit-answers.json, which
fit-answers.test.ts reads too. Then the curve checks built on them."""

import json
import math
from pathlib import Path

import pytest
from test_checks import at_least, at_most, between, check, from_rows, parsed, run

from bl_worker import checks, fits, tables

WEB_TESTS = Path(__file__).parents[2] / "apps" / "web" / "src" / "lib" / "__tests__"
REFERENCE = json.loads((WEB_TESTS / "stats-reference.json").read_text())
ANSWERS = json.loads((WEB_TESTS / "fit-answers.json").read_text())
FIXTURES = Path(__file__).parent / "fixtures" / "tables"


@pytest.mark.parametrize("case", REFERENCE["doses"], ids=lambda c: c["name"])
def test_the_4pl_matches_curve_fit(case):
    found = fits.fit_dose([math.log10(c) for c in case["conc"]], case["y"])
    if case["name"] == "flat":
        assert found.kind == "flat"
        return
    if not case["fits"]:
        assert found == fits.DoseRefusal("step", between=(2.0, 3.0))
        return
    assert isinstance(found, fits.DoseFit)
    assert found.ssr <= case["ssr"] * (1 + 1e-9) + 1e-15
    if abs(case["seLogMid"]) >= 1:
        return
    bottom, top, log_mid, hill = found.params
    for got, want in [
        (bottom, case["bottom"]),
        (top, case["top"]),
        (log_mid, case["logMid"]),
        (hill, case["hill"]),
        (found.log_mid_ci[0], case["ciLogLo"]),
        (found.log_mid_ci[1], case["ciLogHi"]),
        (found.flat_p, case["flatP"]),
    ]:
        # stats.test.ts's tolerance: 1e-6 of the value, or of 1 when it's smaller.
        assert abs(got - want) <= 1e-6 * max(1, abs(want))


def test_lines_match_linregress():
    for case in REFERENCE["lines"]:
        line = fits.fit_line(case["x"], case["y"])
        if case.get("slope") is None:
            assert line is None
            continue
        assert line.slope == pytest.approx(case["slope"], rel=1e-9)
        assert line.r2 == pytest.approx(case["r2"], rel=1e-9)


def test_t_quantiles_match_scipy():
    for q in REFERENCE["quantiles"]:
        assert fits.t_quantile(q["p"], q["df"]) == pytest.approx(q["t"], rel=1e-10)


def sig(x: float, digits: int = 3) -> float:
    return float(f"{x:.{digits}g}")


WORKED = ANSWERS["workedExample"]


def worked_wells() -> tuple[float, list[tuple[str, float, float]]]:
    """The plate's blank and its Drug A wells as (well, dose, reading), from the fixture."""
    plate = tables.parse((FIXTURES / f"{WORKED['fixture']}.csv").read_bytes()).tables[0]
    by_name = {c.name: c for c in plate.columns}
    row_of = {letter: i for i, letter in enumerate(by_name["Column A"].values)}
    rows = [row_of[r] for r in WORKED["plateRows"]]
    blank = sum(by_name[WORKED["blankColumn"]].values[i] for i in rows) / len(rows)
    wells = [
        (f"{letter}{col}", dose, by_name[col].values[row_of[letter]])
        for col, dose in WORKED["doses"].items()
        for letter in WORKED["plateRows"]
    ]
    return blank, wells


def test_the_worked_example_gives_the_charts_ic50():
    blank, wells = worked_wells()
    assert sig(blank) == WORKED["blank"]
    found = fits.fit_dose([math.log10(d) for _, d, _ in wells], [v - blank for _, _, v in wells])
    assert isinstance(found, fits.DoseFit)
    bottom, top, log_mid, hill = found.params
    assert sig(10**log_mid) == WORKED["ic50"]
    assert (sig(10 ** found.log_mid_ci[0]), sig(10 ** found.log_mid_ci[1])) == (
        WORKED["ciLow"],
        WORKED["ciHigh"],
    )
    assert (sig(hill), sig(top), sig(bottom)) == (WORKED["hill"], WORKED["top"], WORKED["bottom"])


def well_sheet(subtract: float = 0.0) -> checks.FileTables:
    """The worked example as a lab lists it by well: the vehicle at dose 0, then Drug A."""
    _, wells = worked_wells()
    vehicle = [["B2", 0, 1.081], ["C2", 0, 1.094], ["D2", 0, 1.088]]
    rows = [[w, d, round(v - subtract, 6)] for w, d, v in [*vehicle, *wells]]
    return from_rows([["Well", "Drug A (µM)", "A570"], *rows], sha="wells")


IC50 = check("curve_fit", between(2, 3), x=None, y=None, fit="4pl", measure="midpoint")


def test_an_ic50_check_reads_the_same_ic50_from_raw_or_blanked_readings():
    raw = run(IC50, well_sheet())
    assert raw.outcome == "passed" and sig(raw.observed) == WORKED["ic50"]
    assert raw.unit == "µM"
    # The vehicle at dose 0 has no place on a log axis; the 15 Drug A wells are what's fitted.
    assert raw.source == checks.Cells("wells", "Table 1", ("B", "C"), tuple(range(3, 18)))
    # A blank shifts top and bottom alike, so the IC50 doesn't move.
    blanked = run(IC50, well_sheet(subtract=WORKED["blank"]))
    assert blanked.observed == pytest.approx(raw.observed, rel=1e-6)
    tight = run(IC50 | {"range": between(3, 5)}, well_sheet())
    assert tight.outcome == "flagged" and tight.observed == raw.observed


def test_a_4pl_r2_check():
    r = run(
        check("curve_fit", at_least(0.98), x="Drug A", y="A570", fit="4pl", measure="r2"),
        well_sheet(),
    )
    assert r.outcome == "passed" and 0.99 < r.observed <= 1


def test_an_ic50_it_cant_pin_down_is_couldnt_check():
    four = from_rows([["Dose (µM)", "A570"], *[[d, 1 / (1 + d)] for d in (0.1, 1, 10, 100)]])
    assert run(IC50, four).reason == (
        "A four-parameter curve needs at least 5 concentrations above zero, and “Dose (µM)” has 4."
    )
    noise = next(c for c in REFERENCE["doses"] if c["name"] == "flat")
    flat = from_rows([["Dose (µM)", "A570"], *zip(noise["conc"], noise["y"], strict=True)])
    assert run(IC50, flat).reason.startswith("“A570” hardly changes with the dose")
    unsure = next(c for c in REFERENCE["doses"] if c["name"] == "bottom not reached")
    loose = from_rows([["Dose (µM)", "A570"], *zip(unsure["conc"], unsure["y"], strict=True)])
    assert run(IC50, loose).reason == (
        "The IC50's 95% range runs past the doses tested (0.01 to 10 µM), so it isn't pinned down."
    )
    below = from_rows(
        [["Dose (µM)", "A570"], [-1, 1], [1, 0.9], [10, 0.5], [100, 0.1], [1000, 0.05]]
    )
    assert run(IC50, below).reason == (
        "“Dose (µM)” is below zero in row 1, and a log scale has no place for it."
    )


def test_a_log_scale_standard_curve():
    # A qPCR standard: Ct falls 3.32 cycles for each tenfold more template.
    rows = [[10**k, 38 - 3.32 * k + 0.05 * (-1) ** k] for k in range(1, 7)]
    sheet = from_rows([["Quantity (copies)", "Ct"], *rows])
    log = run(
        check("curve_fit", at_least(0.98), x="Quantity", y="Ct", fit="log_line", measure="r2"),
        sheet,
    )
    line = run(
        check("curve_fit", at_least(0.98), x="Quantity", y="Ct", fit="line", measure="r2"), sheet
    )
    assert (log.outcome, line.outcome) == ("passed", "flagged")
    assert log.observed == pytest.approx(0.9998, abs=2e-4) and line.observed < 0.6
    # A zero standard is the blank: left out on a log scale, read on a straight one.
    with_zero = from_rows([["Quantity (copies)", "Ct"], [0, 40], *rows])
    r = run(
        check("curve_fit", at_least(0.98), x="Quantity", y="Ct", fit="log_line", measure="r2"),
        with_zero,
    )
    assert r.source.rows == tuple(range(1, 7)) and r.observed == log.observed


OUTSIDE = check("curve_fit", at_most(0), x=None, y=None, fit="line", measure="outside")


def test_samples_must_fall_within_the_standards():
    # Its samples sit in their own table, read in A595, all between 0.4243 and 1.035.
    good = run(OUTSIDE, parsed("Bradford_2026-11-03.xlsx"))
    assert (good.outcome, good.observed) == ("passed", 0.0)
    assert good.source == checks.Cells(
        "Bradford_2026-11-03.xlsx", "Samples", ("C",), tuple(range(7))
    )
    # Samples in the standards' own table: rows with a reading and no concentration.
    same = from_rows(
        [
            ["BSA (µg/mL)", "A595"],
            [0, 0.40],
            [250, 0.58],
            [500, 0.74],
            [1000, 1.03],
            ["", 0.7],
            ["", 1.4],
            ["", 0.2],
        ],
        sha="same",
    )
    r = run(OUTSIDE, same)
    assert (r.outcome, r.observed) == ("flagged", 2.0)
    assert r.source == checks.Cells("same", "Table 1", ("B",), (5, 6))
    none = from_rows([["BSA (µg/mL)", "A595"], [0, 0.4], [250, 0.58], [500, 0.74]])
    assert run(OUTSIDE, none).reason.startswith("No samples to compare")


KINETIC = check(
    "control", at_most(0.1), pattern="blank", by="column", labelColumn=None, column=None, use="each"
)


def kinetic(blank2: float) -> checks.FileTables:
    return from_rows(
        [
            ["Time (s)", "T° 600", "Blank 1", "Blank 2", "Culture 1", "Culture 2"],
            [0, 30.1, 0.05, 0.06, 0.10, 0.11],
            [600, 30.0, 0.05, blank2, 0.21, 0.23],
            [1200, 30.0, 0.06, 0.06, 0.40, 0.44],
        ],
        sha="kinetic",
    )


def test_blank_wells_as_columns_in_a_kinetic_read():
    good = run(KINETIC, kinetic(0.07))
    assert (good.outcome, good.observed) == ("passed", 0.07)
    bad = run(KINETIC, kinetic(0.31))
    assert (bad.outcome, bad.observed) == ("flagged", 0.31)
    assert bad.control == checks.Cells("kinetic", "Table 1", ("C", "D"), (0, 1, 2))
    # They vouch for the cultures; time and temperature aren't readings.
    assert bad.source == checks.Cells("kinetic", "Table 1", ("E", "F"), (0, 1, 2))
    mean = run(KINETIC | {"use": "mean"}, kinetic(0.31))
    assert mean.observed == pytest.approx(0.098333, abs=1e-6) and mean.outcome == "passed"
    # By row, the same file has no blank rows; by column, a file without blank columns says so.
    rows = check(
        "control", at_most(0.1), pattern="blank", labelColumn=None, column="Culture 1", use="each"
    )
    assert run(rows, kinetic(0.07)).reason.startswith("No rows named like “blank”")
    plain = from_rows([["Time (s)", "Culture 1"], [0, 0.1], [600, 0.2]])
    assert run(KINETIC, plain).reason.startswith("No columns named like “blank”")


def test_blank_columns_can_come_from_another_file_of_the_day():
    cultures = from_rows([["Time (s)", "Culture 1"], [0, 0.1], [600, 0.2]], sha="cultures")
    r = run(KINETIC, cultures, lambda: iter([kinetic(0.31)]))
    assert r.outcome == "flagged" and r.control.sha256 == "kinetic"
    assert r.source == checks.Cells("cultures", "Table 1", ("B",), (0, 1))
