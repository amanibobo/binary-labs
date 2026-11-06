"""Writes ~50 messy protein-biophysics lab files into a folder, for dev scans and demos.

uv run python scripts/make_sample_lab.py .data/sample-lab
"""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

from bl_worker import sample_lab


def make(root: Path) -> int:
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    written = sample_lab.files()
    for f in written:
        path = root / f.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f.data)
        os.utime(path, (f.modified.timestamp(), f.modified.timestamp()))
    return len(written)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    args = parser.parse_args()
    print(f"wrote {make(args.folder.resolve())} files to {args.folder}")


if __name__ == "__main__":
    main()
