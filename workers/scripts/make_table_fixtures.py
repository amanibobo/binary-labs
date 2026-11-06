"""Writes the three instrument exports the chart tests and fixtures use, and their parsed
tables for the web app's fixture pages.

uv run python scripts/make_table_fixtures.py

- plate7_A420.csv: a BioTek Gen5 kinetic read of a 96-well plate, preamble and all, with two
  saturated wells read as OVRFLW.
- SEC_trace_141026.csv: an AKTA UNICORN export of a size-exclusion run, UTF-16 with tabs,
  curve names over a units row, each curve with its own volume column and its own length.
- Bradford_2026-10-30.xlsx: a Bradford assay workbook: a standard curve under a merged title
  and a merged two-row header, the samples, and the raw plate as a grid. Its curve bends over
  0 to 2000 µg/mL, so a straight-line fit gets R² 0.94.

For checks (decisions.md, "checking results: expected values and flags"):

- Bradford_2026-11-03.xlsx: the same workbook with a straight curve over 0 to 1000 µg/mL
  (R² 0.999), which passes R² ≥ 0.98.
- Bradford_2026-11-04.xlsx: the same, with the 750 µg/mL standard pipetted short, so the fit
  fails R² ≥ 0.98 (0.88).
- plate8_A595_endpoint.csv: a Gen5 endpoint read listed by well, whose three blanks read
  0.20 to 0.23, out of a "blank at most 0.10" range.
- plate9_A595_endpoint.csv: the same read on another day, blanks at 0.04 to 0.06.
- spectrum_BM3_2026-11-03.csv: a UV scan from 240 to 340 nm with its maximum at 280 nm.
- nanodrop_2026-11-03.csv: a NanoDrop protein export with each sample's 260/280 ratio.
"""

from __future__ import annotations

import io
import math
import random
from collections.abc import Callable
from pathlib import Path

import openpyxl

from bl_worker import samples, tables

WORKERS = Path(__file__).resolve().parents[1]
OUT = WORKERS / "tests" / "fixtures" / "tables"
WEB = WORKERS.parent / "apps" / "web" / "src" / "fixtures" / "tables"

ROWS = "ABCDEFGH"


def plate_reader() -> bytes:
    rng = random.Random(7)
    wells = [f"{r}{c}" for r in ROWS for c in range(1, 13)]
    preamble = [
        ["Software Version", "3.11.19"],
        [],
        ["Experiment File Path:", r"C:\Users\Public\Documents\Experiments\plate7_A420.xpt"],
        ["Protocol File Path:", ""],
        ["Plate Number", "Plate 7"],
        ["Date", "11/3/2026"],
        ["Time", "5:44:12 PM"],
        ["Reader Type:", "Synergy H1"],
        ["Reader Serial Number:", "21031514"],
        ["Reading Type", "Reader"],
        [],
        ["Procedure Details"],
        [],
        ["Plate Type", "96 WELL PLATE (Use plate lid)"],
        ["Set Temperature", "Setpoint 30°C"],
        ["Start Kinetic", '"Runtime 0:30:00 (HH:MM:SS), Interval 0:01:00, 31 Reads"'],
        ["Read", "Absorbance Endpoint"],
        ["", "Full Plate"],
        ["", "Wavelengths:  420"],
        ["End Kinetic"],
        [],
        ["Read 1:420"],
        [],
        ["Time", "T° Read 1:420", *wells],
    ]
    body = []
    for minute in range(31):
        t = f"0:{minute:02d}:00"
        temp = f"{30.0 + 0.1 * math.sin(minute / 4):.1f}"
        cells = []
        for well in wells:
            row = ROWS.index(well[0])
            # Each row of the plate is a substrate concentration; the rate rises with it.
            k = 0.02 + 0.018 * row
            top = 0.35 + 0.22 * row
            a = 0.08 + top * (1 - math.exp(-k * minute)) + rng.gauss(0, 0.004)
            # Two wells at the top concentration saturate the detector late in the read.
            if well in ("H11", "H12") and minute >= 26:
                cells.append("OVRFLW")
            else:
                cells.append(f"{a:.3f}")
        body.append([t, temp, *cells])
    lines = [",".join(row) for row in preamble + body]
    return ("\r\n".join(lines) + "\r\n").encode("utf-8")


def gauss(x: float, mu: float, sigma: float, height: float) -> float:
    return height * math.exp(-((x - mu) ** 2) / (2 * sigma**2))


def akta() -> bytes:
    rng = random.Random(14)
    uv = []
    for i in range(961):
        ml = i * 0.025
        a280 = (
            gauss(ml, 8.6, 0.35, 42)
            + gauss(ml, 13.4, 0.45, 612)
            + gauss(ml, 15.9, 0.5, 38)
            + rng.gauss(0, 0.6)
            + 0.4
        )
        a260 = 0.55 * a280 + gauss(ml, 21.2, 0.6, 180) + rng.gauss(0, 0.5)
        uv.append((ml, a280, a260))
    cond = [(i * 0.1, 15.2 + 0.02 * math.sin(i / 9) + rng.gauss(0, 0.01)) for i in range(241)]
    fractions = [(6.0 + 0.5 * i, f"{ROWS[i // 12]}{i % 12 + 1}") for i in range(25)]
    head = [
        ["Chrom.1"],
        ["UV 1_280", "", "UV 2_260", "", "Cond", "", "Fraction", ""],
        ["ml", "mAU", "ml", "mAU", "ml", "mS/cm", "ml", "(Fractions)"],
    ]
    lines = ["\t".join(row) for row in head]
    for i, (ml, a280, a260) in enumerate(uv):
        row = [f"{ml:.3f}", f"{a280:.3f}", f"{ml:.3f}", f"{a260:.3f}"]
        row += [f"{cond[i][0]:.2f}", f"{cond[i][1]:.3f}"] if i < len(cond) else ["", ""]
        row += [f"{fractions[i][0]:.2f}", fractions[i][1]] if i < len(fractions) else ["", ""]
        lines.append("\t".join(row))
    return ("\r\n".join(lines) + "\r\n").encode("utf-16")


STANDARDS = [0, 125, 250, 500, 750, 1000, 1500, 2000]


def saturating(conc: float) -> float:
    return 0.43 + 0.95 * (1 - math.exp(-conc / 1100))


def straight(conc: float) -> float:
    return 0.43 + 0.00061 * conc


def short_750(conc: float) -> float:
    return straight(conc) - (0.2 if conc == 750 else 0)


def bradford(
    seed: int = 30,
    standards: list[int] = STANDARDS,
    curve: Callable[[float], float] = saturating,
    spread: float = 0.012,
) -> bytes:
    rng = random.Random(seed)
    wb = openpyxl.Workbook()
    wb.properties.created = wb.properties.modified = samples.FIXED_DATE.replace(tzinfo=None)
    ws = wb.active
    ws.title = "Standards"
    ws["A1"] = "Bradford standard curve, BSA in PBS"
    ws.merge_cells("A1:F1")
    ws["A2"] = "Read on Synergy H1 at 595 nm, 10 min after adding reagent"
    ws.append([])
    ws.append(["BSA (µg/mL)", "A595 (AU)", None, None, "Mean (AU)", "SD (AU)"])
    ws.append([None, "Rep 1", "Rep 2", "Rep 3", None, None])
    ws.merge_cells("A4:A5")
    ws.merge_cells("B4:D4")
    ws.merge_cells("E4:E5")
    ws.merge_cells("F4:F5")
    for conc in standards:
        mean = curve(conc)
        reps = [round(mean + rng.gauss(0, spread), 3) for _ in range(3)]
        m = sum(reps) / 3
        sd = math.sqrt(sum((r - m) ** 2 for r in reps) / 2)
        ws.append([conc, *reps, round(m, 4), round(sd, 4)])

    ws = wb.create_sheet("Samples")
    ws.append(["Sample", "Dilution", "A595 (AU)", "Protein (µg/mL)", "Undiluted (mg/mL)"])
    for name, dilution, a595 in [
        ("Lysate", 20, 0.912),
        ("Flow-through", 10, 0.774),
        ("Wash", 1, 0.488),
        ("Elution 1", 10, 1.021),
        ("Elution 2", 10, 0.867),
        ("Elution 3", 5, 0.655),
        ("Dialysed pool", 10, 0.951),
    ]:
        conc = -1100 * math.log(1 - (a595 - 0.43) / 0.95)
        ws.append([name, dilution, a595, round(conc, 1), round(conc * dilution / 1000, 3)])

    ws = wb.create_sheet("Plate")
    ws.append([None, *range(1, 13)])
    for r in ROWS:
        ws.append([r, *[round(0.4 + rng.random() * 0.9, 3) for _ in range(12)]])

    out = io.BytesIO()
    wb.save(out)
    return samples._stable_zip(out.getvalue())


LINEAR_STANDARDS = [0, 125, 250, 500, 750, 1000]


def endpoint(blank: float, day: str, seed: int) -> bytes:
    """A Gen5 endpoint read of one plate column by column, listed by well with its sample."""
    rng = random.Random(seed)
    preamble = [
        ["Software Version", "3.11.19"],
        ["Plate Number", "Plate 1"],
        ["Date", day],
        ["Reader Type:", "Synergy H1"],
        ["Read", "Absorbance Endpoint"],
        ["", "Wavelengths:  595"],
        [],
        ["Well", "Sample", "A595"],
    ]
    body = []
    for i, well in enumerate(["A1", "B1", "C1"]):
        body.append([well, f"Blank {i + 1}", f"{blank + rng.gauss(0, 0.012):.3f}"])
    names = ["Lysate", "Flow-through", "Wash", "Elution 1", "Elution 2", "Elution 3"]
    for i, name in enumerate(names):
        for rep in range(2):
            well = f"{ROWS[(i * 2 + rep + 3) % 8]}{(i * 2 + rep + 3) // 8 + 1}"
            a595 = 0.35 + 0.1 * i + rng.gauss(0, 0.01)
            body.append([well, f"{name} rep {rep + 1}", f"{a595:.3f}"])
    lines = [",".join(row) for row in preamble + body]
    return ("\r\n".join(lines) + "\r\n").encode("utf-8")


def spectrum() -> bytes:
    rng = random.Random(280)
    rows = [["Wavelength (nm)", "Absorbance (AU)"]]
    for nm in range(240, 341):
        a = 0.06 + gauss(nm, 280, 9, 0.82) + gauss(nm, 250, 6, 0.1) + rng.gauss(0, 0.002)
        rows.append([str(nm), f"{a:.4f}"])
    return samples.csv_text(rows)


def nanodrop() -> bytes:
    rows = [["Sample ID", "Conc. (mg/mL)", "A280", "A260", "260/280"]]
    reads = [("BM3 pool", 1.842, 0.57), ("BM3 elution 2", 0.913, 0.61), ("Buffer", 0.004, 0.0)]
    for name, a280, ratio in reads:
        # A 1 Abs = 1 mg/mL protein, as the NanoDrop's default.
        rows.append([name, f"{a280:.3f}", f"{a280:.3f}", f"{a280 * ratio:.3f}", f"{ratio:.2f}"])
    return samples.csv_text(rows)


FILES: dict[str, Callable[[], bytes]] = {
    "plate7_A420.csv": plate_reader,
    "SEC_trace_141026.csv": akta,
    "Bradford_2026-10-30.xlsx": bradford,
    "Bradford_2026-11-03.xlsx": lambda: bradford(1103, LINEAR_STANDARDS, straight, 0.006),
    "Bradford_2026-11-04.xlsx": lambda: bradford(1104, LINEAR_STANDARDS, short_750, 0.006),
    "plate8_A595_endpoint.csv": lambda: endpoint(0.195, "11/4/2026", 8),
    "plate9_A595_endpoint.csv": lambda: endpoint(0.045, "11/3/2026", 9),
    "spectrum_BM3_2026-11-03.csv": spectrum,
    "nanodrop_2026-11-03.csv": nanodrop,
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    WEB.mkdir(parents=True, exist_ok=True)
    for name, make in FILES.items():
        data = make()
        (OUT / name).write_bytes(data)
        (WEB / f"{Path(name).stem}.json").write_bytes(tables.parse(data).to_json())
        print(f"{OUT / name}: {len(data)} bytes")


if __name__ == "__main__":
    main()
