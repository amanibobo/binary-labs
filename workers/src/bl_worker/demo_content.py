"""What the demo lab holds: the sample lab's files plus the chart fixtures, the lab's lists,
its protocols and charts. Names and text follow the web app's fixtures (apps/web/src/fixtures)
so the demo looks like the screenshots. Every file's bytes are the same from run to run."""

from __future__ import annotations

import hashlib
import io
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from PIL import Image, ImageDraw

from bl_worker import sample_lab, samples
from bl_worker.config import WORKERS_DIR

LAB_NAME = "Okafor Lab (demo)"
INSTRUMENT = "Plate reader, room 214"
FIXTURES = WORKERS_DIR / "tests" / "fixtures"
# The lab's own first day, so its lists and membership read as months old.
OPENED = datetime(2026, 8, 3, 9, 0, tzinfo=UTC)


def at(month: int, day: int, hour: int = 10, minute: int = 0) -> datetime:
    return datetime(2026, month, day, hour, minute, tzinfo=UTC)


class Via(StrEnum):
    """How a file reaches the lab: the lab folder (an import), the plate reader, or an upload."""

    IMPORT = "import"
    INSTRUMENT = "instrument"
    UPLOAD = "upload"


@dataclass(frozen=True)
class DemoFile:
    via: Via
    # An import's path in the lab folder, an instrument file's path on the PC, an upload's name.
    path: str
    data: bytes
    modified: datetime
    experiment: str | None = None  # uploads only

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


EXPERIMENTS: list[tuple[str, list[str]]] = [
    # The sample lab's, as evals/labels_expected.json has them.
    ("P450 batch 1", ["batch1"]),
    ("P450 batch 2", ["batch2"]),
    ("P450 batch 3", ["batch3"]),
    ("Lysozyme DSF", ["lysozyme"]),
    ("Thermal shift screen plate 07", ["screen_plate_07", "plate07"]),
    # The fixtures'.
    ("P450 BM3", ["BM3", "CYP102A1"]),
    ("Solubility screen", ["sol screen"]),
    ("Rotation projects", []),
]

PEOPLE: list[tuple[str, list[str]]] = [
    ("Ade Okafor", ["AO", "Ade"]),
    ("Priya Nair", ["PN", "Priya"]),
    ("Jordan Morales", ["JM"]),
    ("Ama Boateng", ["AB"]),
    ("Chen Du", ["CD"]),
    ("Elena Fischer", ["EF"]),
    ("Grace Ho", ["GH"]),
]

# When each part of the lab folder was last touched: (path prefix, first moment, days spread).
# The first prefix that matches wins; a spread of 0 is that exact moment.
FOLDER_DATES: list[tuple[str, datetime, int]] = [
    ("protocols/P450 purification v3.pdf", at(9, 30, 10), 0),
    ("protocols/", at(8, 4), 20),
    ("AB/old protocols/", at(8, 3), 3),
    ("AB/P450/batch1/", at(10, 11), 2),
    ("AB/P450/batch2/", at(10, 12), 2),
    ("AB/P450/batch3/SEC_trace", at(10, 14, 13, 20), 0),
    ("AB/P450/batch3/", at(10, 13), 4),
    ("AO/", at(10, 14, 21, 5), 0),
    ("CD/lysozyme/2026-10-14/", at(10, 14), 1),
    ("CD/lysozyme/", at(10, 15), 5),
    ("CD/", at(9, 1), 25),
    ("EF/thermal_shift/screen_plate_07/", at(10, 20), 2),
    ("EF/meeting notes", at(10, 21, 17), 0),
    ("EF/", at(10, 18), 8),
    ("instrument/", at(8, 25), 50),
    ("shared/", at(10, 28), 2),
    ("GH/", at(10, 26), 5),
    ("JM/", at(11, 2, 11, 30), 0),
]


def folder_date(path: str) -> datetime:
    start, days = at(9, 1), 60
    for prefix, first, spread in FOLDER_DATES:
        if path.startswith(prefix):
            start, days = first, spread
            break
    if days == 0:
        return start
    h = int(hashlib.sha256(path.encode()).hexdigest()[:12], 16)
    return start.replace(hour=8 + h % 11, minute=(h // 11) % 60) + timedelta(days=h % (days + 1))


PURIFICATION_V3_PDF = [
    "P450 BM3 purification, v3",
    "Day 1",
    "1. Resuspend pellet in 40 mL lysis buffer (50 mM Tris pH 8.0, 300 mM NaCl, 10 mM imidazole).",
    "2. Sonicate on ice, 10 s on / 20 s off, 5 min total.",
    "3. Spin 15,000 g, 30 min, 4 C. Keep supernatant.",
    "Day 2",
    "4. Load on 5 mL HisTrap at 1 mL/min.",
    "5. Wash 10 CV, elute 250 mM imidazole in 1 mL fractions.",
    "6. SDS-PAGE of fractions; BM3 ~119 kDa.",
]


def _sec_screenshot() -> bytes:
    """A phone screenshot of a size-exclusion trace: one tall peak and a small one."""
    w, h = 1170, 760
    img = Image.new("RGB", (w, h), (250, 250, 250))
    draw = ImageDraw.Draw(img)
    draw.rectangle([60, 40, w - 40, h - 80], outline=(180, 180, 180))
    points = []
    for x in range(61, w - 40):
        v = (x - 61) / (w - 101) * 24
        y = 900 * math.exp(-((v - 11.2) ** 2) / 0.5) + 160 * math.exp(-((v - 13.9) ** 2) / 0.4)
        points.append((x, h - 81 - y * (h - 140) / 1000))
    draw.line(points, fill=(30, 90, 200), width=4)
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


def files() -> list[DemoFile]:
    out = [DemoFile(Via.IMPORT, f.path, f.data, folder_date(f.path)) for f in sample_lab.files()]
    extra = {
        "protocols/P450 purification v3.pdf": samples.pdf(PURIFICATION_V3_PDF),
        "AO/notes 2026-10-14.txt": (
            b"Oct 14. Batch 3 P450 looks clean on the gel, one faint band near 25 kDa. Reran lane 6."
            b" Ask Priya whether the SEC trace matches.\n"
        ),
        "JM/rotation plan.docx": samples.docx(
            [
                "Rotation project plan",
                "Express CYP102A1 variants, purify, and compare activity against wild type.",
                "Weeks 1-2: shadow AB on the P450 purification. Weeks 3-6: two variants.",
            ]
        ),
        "AB/P450/batch3/SEC_trace_141026.csv": (
            FIXTURES / "tables/SEC_trace_141026.csv"
        ).read_bytes(),
    }
    out += [DemoFile(Via.IMPORT, p, d, folder_date(p)) for p, d in extra.items()]

    tables = FIXTURES / "tables"
    out += [
        DemoFile(
            Via.INSTRUMENT,
            "Gen5 exports/plate5_A600.csv",
            sample_lab.plate_csv(605, "A600"),
            at(10, 20, 14, 2),
        ),
        DemoFile(
            Via.INSTRUMENT,
            "Gen5 exports/plate6_A600.csv",
            sample_lab.plate_csv(606, "A600"),
            at(10, 27, 16, 40),
        ),
        DemoFile(
            Via.INSTRUMENT,
            "Gen5 exports/Bradford_2026-10-30.xlsx",
            (tables / "Bradford_2026-10-30.xlsx").read_bytes(),
            at(10, 30, 15, 10),
        ),
        DemoFile(
            Via.INSTRUMENT,
            "Gen5 exports/plate7_A420.csv",
            (tables / "plate7_A420.csv").read_bytes(),
            at(11, 3, 17, 44),
        ),
    ]

    out += [
        DemoFile(
            Via.UPLOAD,
            "Photo 2026-11-03 16.20.41.jpg",
            samples.gel_jpeg(
                seed=4930,
                make="Apple",
                model="iPhone 15",
                taken="2026:11:03 16:20:41",
                description="SDS-PAGE P450 BM3 batch 4",
            ),
            at(11, 3, 21, 20),
            "P450 BM3",
        ),
        DemoFile(
            Via.UPLOAD,
            "Screenshot 2026-11-03 11.02.09.png",
            _sec_screenshot(),
            at(11, 3, 16, 2),
            "P450 BM3",
        ),
        DemoFile(
            Via.UPLOAD,
            "Solubility screen plan.pdf",
            samples.pdf(
                [
                    "Solubility screen, plates 5 to 7",
                    "Rows A-H: 0 to 350 uM substrate. Columns 1-12: buffer conditions.",
                    "Read A600 for turbidity, then a 30 min kinetic read at 420 nm.",
                ]
            ),
            at(10, 18, 13, 5),
            "Solubility screen",
        ),
    ]
    return out


@dataclass(frozen=True)
class Version:
    title: str
    body: str
    at: datetime
    note: str | None = None


@dataclass(frozen=True)
class Protocol:
    kind: str  # protocol_kind
    versions: list[Version]
    files: list[str] = field(default_factory=list)  # DemoFile paths
    experiments: list[str] = field(default_factory=list)


BUFFER_TABLE = """| Buffer | Tris-HCl pH 8.0 | NaCl | Imidazole |
| --- | --- | --- | --- |
| Lysis | 50 mM | 300 mM | 10 mM |
| Wash | 50 mM | 300 mM | 25 mM |
| Elution | 50 mM | 300 mM | 250 mM |

"""

# apps/web/src/fixtures/protocols.ts, purificationBody.
PURIFICATION = (
    """Run this for every BM3 batch. Plan on two days: expression and lysis on day one, the nickel column and the gel on day two.

## Before you start

- Thaw one 50 mL pellet on ice for 20 min.
- Make 200 mL lysis buffer fresh and keep it at 4 °C.

"""
    + BUFFER_TABLE
    + """## Steps

1. Resuspend the pellet in 40 mL lysis buffer with one protease inhibitor tablet.
2. Sonicate on ice, 10 s on and 20 s off, for 5 min total at 40% amplitude.
3. Spin the lysate at 15,000 g for 30 min at 4 °C. Keep the supernatant.
4. Load the supernatant on a 5 mL HisTrap column at 1 mL/min.
5. Wash with 10 column volumes of wash buffer, then elute in 1 mL fractions.
6. Run fractions on an SDS-PAGE gel next to the ladder. BM3 runs near 119 kDa.

> Keep the gel photo with the batch number in the file name, so search finds it next to the batch's yields.

## What a good run looks like

The A418/A280 ratio of the pooled fractions is above 0.4, and the gel shows one strong band near 119 kDa.
"""
)
PURIFICATION_SHORT_SPIN = PURIFICATION.replace("15,000 g for 30 min", "12,000 g for 20 min")

SDS_PAGE_V1 = """Bis-Tris 12% gels for the nickel column fractions.

## Steps

1. Mix 15 µL sample with 5 µL 4x Laemmli buffer and 5% beta-mercaptoethanol.
2. Heat at 95 °C for 5 min and spin down for 1 min.
3. Load 10 µL per lane, with the PageRuler ladder in lane 1.
4. Run at 150 V for 45 min in MES running buffer.
5. Stain with Coomassie for 1 h and destain overnight.
"""
SDS_PAGE_V2 = (
    SDS_PAGE_V1
    + """
## What to expect

Full-length BM3 runs near 118 kDa; the heme domain alone runs near 55 kDa.
"""
)
SDS_PAGE_V3 = SDS_PAGE_V2.replace(
    "5. Stain with Coomassie for 1 h and destain overnight.",
    "5. Stain with Coomassie for 30 min and destain for 2 h.\n"
    "6. Image the gel on the ChemiDoc and name the photo with the batch number.",
)

BRADFORD_V1 = """Protein concentration against a BSA standard curve, in a 96-well plate.

## Steps

1. Make BSA standards at 0, 125, 250, 500, 750, 1000, 1500 and 2000 µg/mL.
2. Pipette 5 µL of each standard and sample into the plate in triplicate.
3. Add 250 µL Bradford reagent to each well and mix on the shaker for 30 s.
4. Incubate at room temperature for 10 min.
5. Read absorbance on the plate reader in room 214.
"""
BRADFORD_V2 = BRADFORD_V1.replace(
    "5. Read absorbance on the plate reader in room 214.",
    "5. Read absorbance at 595 nm on the plate reader in room 214.\n"
    "6. Fit the standards' means and read the samples off the curve. Dilute anything above 1500 µg/mL.",
)

CHEMIDOC = """How to image a Coomassie or stain-free gel on the ChemiDoc MP.

## Setup

1. Wipe the tray with water and place the gel in the middle.
2. Pick the Coomassie application, or Stain-free for TGX gels.

## Exposure

Start with auto exposure for Coomassie gels, then lower it if the bands saturate.

## Saving

Export as JPEG and name the file with the batch number and the date.
"""

PROTOCOLS: list[Protocol] = [
    Protocol(
        "protocol",
        [
            Version(
                "P450 purification",
                PURIFICATION_SHORT_SPIN.replace(BUFFER_TABLE, ""),
                at(9, 30, 10, 5),
            ),
            Version(
                "P450 purification", PURIFICATION_SHORT_SPIN, at(10, 12), "Added the buffer table"
            ),
            Version("P450 BM3 purification", PURIFICATION_SHORT_SPIN, at(10, 21, 9, 12)),
            Version(
                "P450 BM3 purification", PURIFICATION, at(11, 2, 15, 20), "Longer spin after lysis"
            ),
        ],
        files=[
            "protocols/P450 purification v3.pdf",
            "AB/P450/batch3/IMG_4821.jpg",
            "protocols/Ni-NTA purification.docx",
            "AB/P450/batch3/SEC_trace_141026.csv",
        ],
        experiments=["P450 BM3", "P450 batch 1", "P450 batch 2", "P450 batch 3"],
    ),
    Protocol(
        "protocol",
        [
            Version("SDS-PAGE for BM3 fractions", SDS_PAGE_V1, at(9, 15, 11)),
            Version(
                "SDS-PAGE for BM3 fractions", SDS_PAGE_V2, at(10, 2, 14), "Expected band sizes"
            ),
            Version("SDS-PAGE for BM3 fractions", SDS_PAGE_V3, at(10, 15, 11, 10), "Shorter stain"),
        ],
        files=["protocols/SDS-PAGE_protocol.pdf", "AB/P450/batch1/IMG_4807.jpg"],
    ),
    Protocol(
        "protocol",
        [
            Version("Bradford assay", BRADFORD_V1, at(10, 20, 9, 30)),
            Version("Bradford assay", BRADFORD_V2, at(10, 28, 13), "Read at 595 nm"),
        ],
        files=["Gen5 exports/Bradford_2026-10-30.xlsx"],
        experiments=["Solubility screen"],
    ),
    Protocol(
        "tutorial",
        [Version("Imaging a gel on the ChemiDoc", CHEMIDOC, at(10, 19, 16, 30))],
        files=["AB/P450/batch2/IMG_4814.jpg"],
    ),
]


def _axis(title: str, unit: str) -> dict[str, Any]:
    return {"title": title, "unit": unit, "min": None, "max": None}


@dataclass(frozen=True)
class Chart:
    file: str  # a DemoFile path
    sheet: str
    title: str
    spec: dict[str, Any]
    protocol: str | None = None  # a protocol's first title


# apps/web/src/fixtures/charts.ts.
CHARTS: list[Chart] = [
    Chart(
        "Gen5 exports/Bradford_2026-10-30.xlsx",
        "Standards",
        "Bradford standard curve, Oct 30",
        {
            "version": 1,
            "type": "scatter",
            "x": {"column": "A", **_axis("BSA", "µg/mL")},
            "y": {**_axis("A595", "AU"), "scale": "linear"},
            "series": [{"column": "E", "name": "Mean of 3", "color": "blue", "error": "F"}],
            "legend": "top",
        },
        protocol="Bradford assay",
    ),
    Chart(
        "AB/P450/batch3/SEC_trace_141026.csv",
        "Table 1",
        "Batch 3 SEC, Superdex 200",
        {
            "version": 1,
            "type": "line",
            "x": {"column": "A", **_axis("Elution volume", "ml")},
            "y": {**_axis("Absorbance", "mAU"), "scale": "linear"},
            "series": [
                {"column": "B", "name": "A280", "color": "blue", "error": None},
                {"column": "D", "name": "A260", "color": "orange", "error": None},
            ],
            "legend": "top",
        },
        protocol="P450 purification",
    ),
    Chart(
        "Gen5 exports/plate7_A420.csv",
        "Table 1",
        "Plate 7 kinetics at 420 nm",
        {
            "version": 1,
            "type": "line",
            "x": {"column": "A", **_axis("Time", "min")},
            "y": {**_axis("A420", "AU"), "scale": "linear"},
            "series": [
                {"column": "C", "name": "Row A, 0 µM", "color": "blue", "error": None},
                {"column": "AM", "name": "Row D, 150 µM", "color": "orange", "error": None},
                {"column": "CI", "name": "Row H, 350 µM", "color": "aqua", "error": None},
            ],
            "legend": "top",
        },
    ),
]

VIDEO = DemoFile(
    Via.UPLOAD, "Loading the nickel column.mp4", (FIXTURES / "clip.mp4").read_bytes(), at(11, 2, 16)
)
VIDEO_PROTOCOL = "P450 purification"

# macOS `say` reading the fixtures' talk-through transcript (apps/web/src/fixtures/talk-throughs.ts),
# so the recording really says what its transcript will. On the purification page's current version.
TALK_THROUGH = DemoFile(
    Via.UPLOAD,
    "Talk-through 2026-11-04 10.15.m4a",
    (FIXTURES / "bm3-lysis-talk-through.m4a").read_bytes(),
    at(11, 4, 10, 15),
)
TALK_THROUGH_MS = 39_978
TALK_THROUGH_PROTOCOL = "P450 purification"
