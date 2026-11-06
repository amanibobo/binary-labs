"""The sample lab: ~50 messy protein-biophysics files (P450 BM3, lysozyme DSF, a thermal shift
screen) with hand-written labels in evals/labels_expected.json. scripts/make_sample_lab.py
writes them to a folder; bl demo-lab stores them in a demo lab. Needs the dev group (fpdf2).
The same call always gives the same bytes and times."""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime

from bl_worker import samples
from bl_worker.config import WORKERS_DIR


@dataclass(frozen=True)
class SampleFile:
    path: str  # relative to the lab folder, forward slashes
    data: bytes
    modified: datetime


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


def kinetics_xlsx(rng: random.Random, batch: int, *, messy: bool = False) -> bytes:
    rows: list[list[object]] = [["Sample", "Conc (uM)", "Rate (nmol/min/mg)", "NADPH (uM)"]]
    for i in range(24):
        rows.append([f"P450-b{batch}-{i:02d}", 0.5 * (i + 1), round(rng.uniform(50, 900), 1), 200])
    sheets = {"Kinetics": rows, "Notes": [["batch", batch], ["reader", "SpectraMax"]]}
    if messy:
        sheets["Sheet3"] = [["DO NOT USE - old fit"], ["Km (uM)", 12.4], ["kcat (1/s)", 38.0]]
    return samples.xlsx(sheets)


def files() -> list[SampleFile]:
    rng = random.Random(4821)
    out: dict[str, SampleFile] = {}

    def add(rel: str, data: bytes | str, when: datetime | None = None) -> None:
        when = when or datetime(2026, rng.randint(1, 10), rng.randint(1, 28), rng.randint(8, 20))
        out[rel] = SampleFile(rel, data.encode() if isinstance(data, str) else data, when)

    sds = samples.pdf(SDS_PAGE)
    add("protocols/SDS-PAGE_protocol.pdf", sds)
    add("AB/old protocols/SDS-PAGE_protocol.pdf", sds)  # duplicate
    add(
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
    add("protocols/buffers.pdf", samples.pdf(BUFFERS))
    add("protocols/thermal_shift_DSF.pdf", samples.pdf(THERMAL_SHIFT))
    add("protocols/README.md", "# Protocols\nAsk AB before changing the SDS-PAGE gel %.\n")

    for batch in (1, 2, 3):
        base = f"AB/P450/batch{batch}"
        for lane_set in range(2):
            n = 4800 + batch * 7 + lane_set
            add(
                f"{base}/IMG_{n}.jpg",
                samples.gel_jpeg(
                    seed=n,
                    make="Bio-Rad",
                    model="ChemiDoc MP",
                    taken=f"2026:10:{10 + batch:02d} 1{lane_set}:2{batch}:00",
                    description=f"SDS-PAGE P450 BM3 batch {batch}",
                ),
            )
        add(
            f"{base}/gel notes.pdf",
            samples.pdf(
                [
                    f"Gel notes, P450 BM3 batch {batch}",
                    "Lane 1 ladder; lanes 2-6 Ni-NTA fractions 8-12.",
                    "Strong band near 118 kDa in fractions 9-11" + DEGRADATION.get(batch, "."),
                ]
            ),
        )
        add(f"{base}/plate_A600_{batch}.csv", plate_csv(batch, "A600"))
        add(f"{base}/plate_A418_{batch}.csv", plate_csv(batch + 10, "A418"))
        add(f"{base}/kinetics.xlsx", kinetics_xlsx(rng, batch))
    add(
        "AB/P450/batch3/IMG_4821.jpg",
        samples.gel_jpeg(
            seed=4821,
            make="Apple",
            model="iPhone 15",
            taken="2026:10:14 15:32:01",
            description="P450 batch 3 gel, photo from the bench",
        ),
    )
    add("AB/P450/batch3/final_v2_REAL.xlsx", kinetics_xlsx(rng, 3, messy=True))
    add("AB/P450/batch3/final_v2.xlsx", kinetics_xlsx(rng, 2))
    add("AB/P450/batch3/final.xlsx", kinetics_xlsx(rng, 1))
    copy = out["AB/P450/batch3/kinetics.xlsx"].data
    add("AB/P450/batch3/Copy of kinetics.xlsx", copy)  # duplicate

    lyso = "CD/lysozyme/2026-10-14"
    add(f"{lyso}/DSF_run1.csv", plate_csv(41, "Fluorescence"))
    add(f"{lyso}/DSF_run2.csv", plate_csv(42, "Fluorescence"))
    add(f"{lyso}/data (1).csv", plate_csv(41, "Fluorescence"))  # duplicate of run1
    add(f"{lyso}/notes.txt", "DSF lysozyme + NAG3. Run 2 has a bubble in well C7.\n")
    add(f"{lyso}/IMG_5003.jpg", samples.gel_jpeg(seed=5003, model="iPhone 13"))
    add(
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
    add(
        "CD/lysozyme/crystal tray plan.docx",
        samples.docx(
            [
                "Lysozyme crystal tray, hanging drop",
                "Reservoir 0.8-1.2 M NaCl, 50 mM NaOAc pH 4.6, 24-well VDX plate.",
            ]
        ),
    )
    add("CD/Untitled.txt", "call Fisher about the HisTrap order\n")
    add("CD/scan0003.pdf", samples.pdf(["Invoice 2219 - HisTrap HP 5 mL x2"]))

    ef = "EF/thermal_shift/screen_plate_07"
    for i in range(1, 5):
        add(f"{ef}/plate07_read{i}.csv", plate_csv(700 + i, "Fluorescence"))
    add(
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
    add("EF/thermal_shift/thermal_shift_DSF.pdf", samples.pdf(THERMAL_SHIFT))  # dup
    add(
        "EF/meeting notes 10-21.md",
        "- P450 batch 3 looks clean on the gel\n- reorder SYPRO\n",
    )
    add("EF/IMG_4821.jpg", samples.gel_jpeg(seed=9001, model="iPhone 15"))  # same name, other photo

    add("instrument/QuantStudio/run_0042.eds", bytes(rng.randbytes(2048)))
    add("instrument/flow/sample_A1.fcs", b"FCS3.1    " + rng.randbytes(1024))
    add("instrument/legacy_export.pdf", b"%PDF-1.3 truncated by the USB stick")
    add(
        "shared/lab meeting.docx",
        samples.docx(
            [
                "Lab meeting 2026-10-28",
                "AB: P450 batch 3 purified, final_v2_REAL has the kinetics.",
                "CD: lysozyme DSF with NAG3 shows +3.3 C.",
            ]
        ),
    )
    add("shared/IMG_4821 copy.jpg", out["AB/P450/batch3/IMG_4821.jpg"].data)
    add(
        "GH/rotation/week1 notes.txt",
        "Shadowed AB on the P450 SDS-PAGE. Ask about MES vs MOPS.\n",
    )

    # A HeLa drug A dose series: the plate reads, and 12 handwritten notebook pages for plate 3
    # photographed a minute or two apart (one smudged), whose outer wells drifted.
    hela = "AB/hela_drugA"
    add(f"{hela}/plate2_A570.csv", plate_csv(902, "A570"), datetime(2026, 10, 30, 16, 5))
    add(f"{hela}/plate3_A570.csv", plate_csv(903, "A570"), datetime(2026, 11, 5, 16, 40))
    add(
        f"{hela}/plate4 notes.txt",
        "Plate 4, repeat of the drug A dose series in HeLa with PBS in all outer wells.\n"
        "No edge drift this time. IC50 about 11 uM. This is the one to use.\n",
        datetime(2026, 11, 8, 15, 10),
    )
    for i, page in enumerate(note_pages()):
        add(
            f"AB/notebook/hela drug A plate 3/page_{i + 1:02d}.jpg",
            page,
            datetime(2026, 11, 5, 17, 2 + 2 * i),
        )
    return list(out.values())


NOTE_PAGES = WORKERS_DIR / "tests" / "fixtures" / "notes"


def note_pages() -> list[bytes]:
    """The 12 notebook pages from scripts/make_note_pages.py, when the checkout has them."""
    return [p.read_bytes() for p in sorted(NOTE_PAGES.glob("page_*.jpg"))]
