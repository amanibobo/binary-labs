"""Writes ~50 messy protein-biophysics lab files into a folder, for dev scans and demos.

uv run python scripts/make_sample_lab.py .data/sample-lab
"""

from __future__ import annotations

import argparse
import os
import random
import shutil
from datetime import datetime
from pathlib import Path

from bl_worker import samples

rng = random.Random(4821)

SDS_PAGE = [
    "SDS-PAGE protocol (Bis-Tris, 12%)",
    "1. Mix 15 uL sample with 5 uL 4x Laemmli buffer + 5% beta-mercaptoethanol.",
    "2. Heat at 95 C for 5 min, spin down 1 min.",
    "3. Load 10 uL per lane; lane 1 PageRuler ladder.",
    "4. Run at 150 V for 45 min in MES running buffer.",
    "5. Stain with Coomassie for 1 h, destain overnight.",
    "Expected: CYP450 BM3 runs near 118 kDa; heme domain alone near 55 kDa.",
]
NI_NTA = [
    "Ni-NTA purification of His-tagged P450 BM3",
    "Equilibrate 5 mL HisTrap with 10 CV lysis buffer.",
    "Load clarified lysate at 1 mL/min. Wash with 20 mM imidazole, 15 CV.",
    "Elute with a 20-250 mM imidazole gradient over 20 CV; collect 1 mL fractions.",
    "Pool red fractions (A418/A280 > 0.8). Dialyse into 50 mM KPi pH 7.5 overnight.",
]
BUFFERS = [
    "Buffer recipes",
    "Lysis: 50 mM Tris-HCl pH 8.0, 300 mM NaCl, 10 mM imidazole, 1 mM PMSF.",
    "Wash: lysis + 20 mM imidazole. Elution: lysis + 250 mM imidazole.",
    "Storage: 50 mM KPi pH 7.5, 10% glycerol, flash freeze in liquid N2.",
]
THERMAL_SHIFT = [
    "Thermal shift assay (DSF) with SYPRO Orange",
    "5x SYPRO, 2 uM protein, 25-95 C at 1 C/min on the QuantStudio.",
    "Tm of apo lysozyme expected near 72 C; ligand shifts above 2 C are hits.",
]


DEGRADATION = {3: "; faint degradation at 55 kDa."}


def plate_csv(seed: int, read: str) -> bytes:
    r = random.Random(seed)
    rows: list[list[object]] = [
        ["Software Version", "3.11.19"],
        ["Experiment File Path", f"C:\\Gen5\\{read}_{seed}.xpt"],
        ["Read", read],
        ["Well", f"{read} (AU)", "Time (s)", "Temp (C)"],
    ]
    for row in "ABCDEFGH":
        for col in range(1, 13):
            rows.append([f"{row}{col}", round(r.uniform(0.05, 1.8), 3), 30, 25.0])
    return samples.csv_text(rows)


def kinetics_xlsx(batch: int, *, messy: bool = False) -> bytes:
    rows: list[list[object]] = [["Sample", "Conc (uM)", "Rate (nmol/min/mg)", "NADPH (uM)"]]
    for i in range(24):
        rows.append([f"P450-b{batch}-{i:02d}", 0.5 * (i + 1), round(rng.uniform(50, 900), 1), 200])
    sheets = {"Kinetics": rows, "Notes": [["batch", batch], ["reader", "SpectraMax"]]}
    if messy:
        sheets["Sheet3"] = [["DO NOT USE - old fit"], ["Km (uM)", 12.4], ["kcat (1/s)", 38.0]]
    return samples.xlsx(sheets)


def write(root: Path, rel: str, data: bytes | str, when: datetime | None = None) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)
    when = when or datetime(2026, rng.randint(1, 10), rng.randint(1, 28), rng.randint(8, 20))
    os.utime(path, (when.timestamp(), when.timestamp()))
    return path


def make(root: Path) -> int:
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)

    sds = samples.pdf(SDS_PAGE)
    write(root, "protocols/SDS-PAGE_protocol.pdf", sds)
    write(root, "AB/old protocols/SDS-PAGE_protocol.pdf", sds)  # duplicate
    write(
        root,
        "protocols/Ni-NTA purification.docx",
        samples.docx(
            NI_NTA,
            [
                ["Step", "Buffer", "CV"],
                ["Wash", "20 mM imidazole", "15"],
                ["Elute", "250 mM imidazole", "20"],
            ],
        ),
    )
    write(root, "protocols/buffers.pdf", samples.pdf(BUFFERS))
    write(root, "protocols/thermal_shift_DSF.pdf", samples.pdf(THERMAL_SHIFT))
    write(root, "protocols/README.md", "# Protocols\nAsk AB before changing the SDS-PAGE gel %.\n")

    for batch in (1, 2, 3):
        base = f"AB/P450/batch{batch}"
        for lane_set in range(2):
            n = 4800 + batch * 7 + lane_set
            write(
                root,
                f"{base}/IMG_{n}.jpg",
                samples.gel_jpeg(
                    seed=n,
                    make="Bio-Rad",
                    model="ChemiDoc MP",
                    taken=f"2026:10:{10 + batch:02d} 1{lane_set}:2{batch}:00",
                    description=f"SDS-PAGE P450 BM3 batch {batch}",
                ),
            )
        write(
            root,
            f"{base}/gel notes.pdf",
            samples.pdf(
                [
                    f"Gel notes, P450 BM3 batch {batch}",
                    "Lane 1 ladder; lanes 2-6 Ni-NTA fractions 8-12.",
                    "Strong band near 118 kDa in fractions 9-11" + DEGRADATION.get(batch, "."),
                ]
            ),
        )
        write(root, f"{base}/plate_A600_{batch}.csv", plate_csv(batch, "A600"))
        write(root, f"{base}/plate_A418_{batch}.csv", plate_csv(batch + 10, "A418"))
        write(root, f"{base}/kinetics.xlsx", kinetics_xlsx(batch))
    write(
        root,
        "AB/P450/batch3/IMG_4821.jpg",
        samples.gel_jpeg(
            seed=4821,
            make="Apple",
            model="iPhone 15",
            taken="2026:10:14 15:32:01",
            description="P450 batch 3 gel, photo from the bench",
        ),
    )
    write(root, "AB/P450/batch3/final_v2_REAL.xlsx", kinetics_xlsx(3, messy=True))
    write(root, "AB/P450/batch3/final_v2.xlsx", kinetics_xlsx(2))
    write(root, "AB/P450/batch3/final.xlsx", kinetics_xlsx(1))
    copy = (root / "AB/P450/batch3/kinetics.xlsx").read_bytes()
    write(root, "AB/P450/batch3/Copy of kinetics.xlsx", copy)  # duplicate

    lyso = "CD/lysozyme/2026-10-14"
    write(root, f"{lyso}/DSF_run1.csv", plate_csv(41, "Fluorescence"))
    write(root, f"{lyso}/DSF_run2.csv", plate_csv(42, "Fluorescence"))
    write(root, f"{lyso}/data (1).csv", plate_csv(41, "Fluorescence"))  # duplicate of run1
    write(root, f"{lyso}/notes.txt", "DSF lysozyme + NAG3. Run 2 has a bubble in well C7.\n")
    write(root, f"{lyso}/IMG_5003.jpg", samples.gel_jpeg(seed=5003, model="iPhone 13"))
    write(
        root,
        "CD/lysozyme/Tm_summary.xlsx",
        samples.xlsx(
            {
                "Tm": [
                    ["Ligand", "Tm (C)", "dTm (C)"],
                    ["apo", 72.1, 0],
                    ["NAG3", 75.4, 3.3],
                    ["NAG1", 72.9, 0.8],
                ]
            }
        ),
    )
    write(
        root,
        "CD/lysozyme/crystal tray plan.docx",
        samples.docx(
            [
                "Lysozyme crystal tray, hanging drop",
                "Reservoir 0.8-1.2 M NaCl, 50 mM NaOAc pH 4.6, 24-well VDX plate.",
            ]
        ),
    )
    write(root, "CD/Untitled.txt", "call Fisher about the HisTrap order\n")
    write(root, "CD/scan0003.pdf", samples.pdf(["Invoice 2219 - HisTrap HP 5 mL x2"]))

    ef = "EF/thermal_shift/screen_plate_07"
    for i in range(1, 5):
        write(root, f"{ef}/plate07_read{i}.csv", plate_csv(700 + i, "Fluorescence"))
    write(
        root,
        f"{ef}/hits.xlsx",
        samples.xlsx(
            {
                "Hits": [
                    ["Well", "Compound", "dTm (C)"],
                    ["B4", "EF-0113", 2.8],
                    ["F9", "EF-0457", 4.1],
                ]
            }
        ),
    )
    write(root, "EF/thermal_shift/thermal_shift_DSF.pdf", samples.pdf(THERMAL_SHIFT))  # dup
    write(
        root,
        "EF/meeting notes 10-21.md",
        "- P450 batch 3 looks clean on the gel\n- reorder SYPRO\n",
    )
    write(
        root, "EF/IMG_4821.jpg", samples.gel_jpeg(seed=9001, model="iPhone 15")
    )  # same name, other photo

    write(root, "instrument/QuantStudio/run_0042.eds", bytes(rng.randbytes(2048)))
    write(root, "instrument/flow/sample_A1.fcs", b"FCS3.1    " + rng.randbytes(1024))
    write(root, "instrument/legacy_export.pdf", b"%PDF-1.3 truncated by the USB stick")
    write(
        root,
        "shared/lab meeting.docx",
        samples.docx(
            [
                "Lab meeting 2026-10-28",
                "AB: P450 batch 3 purified, final_v2_REAL has the kinetics.",
                "CD: lysozyme DSF with NAG3 shows +3.3 C.",
            ]
        ),
    )
    write(root, "shared/IMG_4821 copy.jpg", (root / "AB/P450/batch3/IMG_4821.jpg").read_bytes())
    write(
        root,
        "GH/rotation/week1 notes.txt",
        "Shadowed AB on the P450 SDS-PAGE. Ask about MES vs MOPS.\n",
    )
    return sum(1 for p in root.rglob("*") if p.is_file())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    args = parser.parse_args()
    print(f"wrote {make(args.folder.resolve())} files to {args.folder}")


if __name__ == "__main__":
    main()
