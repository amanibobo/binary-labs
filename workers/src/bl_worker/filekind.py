from __future__ import annotations

import mimetypes
from pathlib import PurePosixPath

import filetype

from bl_worker.domain import FileKind

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Magic bytes win over the extension: lab files get renamed by hand.
MAGIC_KINDS: dict[str, FileKind] = {
    "application/pdf": FileKind.PDF,
    DOCX: FileKind.DOCUMENT,
    XLSX: FileKind.SPREADSHEET,
}

EXTENSION_KINDS: dict[str, tuple[FileKind, str]] = {
    ".pdf": (FileKind.PDF, "application/pdf"),
    ".xlsx": (FileKind.SPREADSHEET, XLSX),
    ".xlsm": (FileKind.SPREADSHEET, "application/vnd.ms-excel.sheet.macroEnabled.12"),
    ".csv": (FileKind.SPREADSHEET, "text/csv"),
    ".tsv": (FileKind.SPREADSHEET, "text/tab-separated-values"),
    ".docx": (FileKind.DOCUMENT, DOCX),
    ".txt": (FileKind.TEXT, "text/plain"),
    ".md": (FileKind.TEXT, "text/markdown"),
    ".log": (FileKind.TEXT, "text/plain"),
}


def detect(name: str, data: bytes) -> tuple[FileKind, str]:
    """Returns (file_kind, mime) from the content first, then the extension."""
    guess = filetype.guess(data)
    if guess is not None:
        if guess.mime in MAGIC_KINDS:
            return MAGIC_KINDS[guess.mime], guess.mime
        if guess.mime.startswith("image/"):
            return FileKind.IMAGE, guess.mime
    ext = PurePosixPath(name).suffix.lower()
    if ext in EXTENSION_KINDS:
        return EXTENSION_KINDS[ext]
    if guess is not None:
        return FileKind.OTHER, guess.mime
    return FileKind.OTHER, mimetypes.guess_type(name)[0] or "application/octet-stream"
