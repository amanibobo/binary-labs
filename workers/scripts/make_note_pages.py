"""Writes the 12 handwritten notebook pages of the HeLa drug A dose series (plate 3, outer-well
drift) into tests/fixtures/notes/, as phone photos of a lined notebook. Page 7 is smudged
over its 50 µM reading, so its value can't be read. Needs macOS's Bradley Hand and Noteworthy
fonts; the pages are committed, so this only runs to change them.

uv run python scripts/make_note_pages.py
"""

from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "notes"
FONTS = [
    "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
    "/System/Library/Fonts/Noteworthy.ttc",
]
W, H = 900, 1200

# Each page: its lines. "~" marks the words to smudge on page 7.
PAGES: list[list[str]] = [
    [
        "Nov 3 2026   HeLa drug A dose series",
        "Plate 3   (AB)",
        "Aim: IC50 of drug A in HeLa, MTT readout",
        "Seeded 5000 cells/well, 96-well, 24 h",
        "Drug A: 0.1, 1, 10, 50, 100 uM",
        "triplicate, DMSO 0.1% vehicle",
    ],
    [
        "Plate layout, plate 3",
        "rows B-D: drug A, cols 2-6 low to high",
        "rows E-G: vehicle and media blanks",
        "outer wells (row A, row H, col 1, col 12)",
        "used for samples too - no PBS edge",
    ],
    [
        "Treatment",
        "drug A added 9:40, 37 C, 5% CO2",
        "30 min pre-incubation on the warmer",
        "then back in incubator, 48 h",
    ],
    [
        "Nov 5  MTT",
        "MTT 0.5 mg/mL, 3 h at 37 C",
        "dissolved in DMSO 100 uL/well",
        "read A570 on the plate reader",
    ],
    [
        "Readings A570  (mean of 3)",
        "vehicle   1.21",
        "0.1 uM    1.18",
        "1 uM      1.05",
        "10 uM     0.71",
    ],
    [
        "Readings, continued",
        "100 uM    0.22",
        "blank     0.06",
        "row A and row H read higher than middle rows",
    ],
    [
        "Page 7  edge check",
        "50 uM well B6:  ~0.38~",
        "evaporation at the edges? lids fogged",
        "column 12 wells 15-20% above column 6",
    ],
    [
        "Averages",
        "middle wells only: IC50 about 12 uM",
        "with outer wells: curve flat above 10 uM",
        "SD high in rows A and H",
    ],
    [
        "What went wrong",
        "Outer wells drifted - edge effect",
        "results unreliable, call this run FAILED",
        "do not use plate 3 for the IC50",
    ],
    [
        "Next time",
        "repeat as plate 4 on Nov 6",
        "fill outer wells with PBS, no samples",
        "seal with breathable film",
    ],
    [
        "To order",
        "MTT 1 g, DMSO, breathable seals",
        "ask Chen about the warmer drift",
    ],
    [
        "Questions for Ama",
        "is DMSO 0.1% fine for 48 h?",
        "should we switch to CellTiter-Glo?",
    ],
]


def page(n: int, lines: list[str], rng: random.Random) -> Image.Image:
    img = Image.new("RGB", (W, H), (246, 243, 232))
    d = ImageDraw.Draw(img)
    for y in range(140, H - 40, 52):
        d.line([(40, y), (W - 40, y)], fill=(176, 196, 222), width=2)
    d.line([(110, 0), (110, H)], fill=(222, 150, 150), width=2)
    font = ImageFont.truetype(FONTS[n % 2], 38)
    smudges: list[tuple[int, int, int, int]] = []
    y = 100
    for line in lines:
        x = 130 + rng.randint(-6, 6)
        for i, part in enumerate(line.split("~")):
            ink = (28, 38, 92) if n % 3 else (30, 30, 34)
            d.text((x, y + rng.randint(-3, 3)), part, font=font, fill=ink)
            width = int(d.textlength(part, font=font))
            if i % 2 == 1:
                smudges.append((x - 10, y - 8, x + width + 10, y + 52))
            x += width
        y += 104 if len(lines) < 5 else 78
    d.text((W - 110, H - 80), str(n + 1), font=font, fill=(90, 90, 90))
    for box in smudges:
        # A thumb dragged through wet ink: smeared sideways, darkest in the middle, soft edges.
        region = img.crop(box)
        rw, rh = region.size
        smeared = (
            region.resize((max(rw // 14, 1), rh))
            .resize((rw, rh))
            .filter(ImageFilter.GaussianBlur(7))
        )
        smeared = Image.blend(smeared, Image.new("RGB", (rw, rh), (70, 72, 110)), 0.45)
        mask = Image.new("L", (rw, rh), 0)
        ImageDraw.Draw(mask).ellipse((0, rh // 8, rw, rh - rh // 8), fill=255)
        img.paste(smeared, box[:2], mask.filter(ImageFilter.GaussianBlur(3)))
    # A phone photo: slightly turned, a little soft, uneven light.
    img = img.rotate(
        rng.uniform(-1.5, 1.5), resample=Image.Resampling.BICUBIC, fillcolor=(60, 58, 54)
    )
    shade = Image.linear_gradient("L").resize((W, H)).point(lambda v: 255 - v // 8)
    img = Image.composite(img, Image.new("RGB", (W, H), (200, 196, 186)), shade)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rng = random.Random(2026)
    for n, lines in enumerate(PAGES):
        page(n, lines, rng).save(OUT / f"page_{n + 1:02d}.jpg", quality=72, optimize=True)
    print(f"wrote {len(PAGES)} pages to {OUT}")


if __name__ == "__main__":
    main()
