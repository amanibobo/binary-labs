from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID


class SourceKind(StrEnum):
    DROPBOX = "dropbox"
    LOCAL = "local"
    # Files people send us; the web app records them, so there is nothing to list.
    UPLOAD = "upload"
    # Files an instrument PC's uploader sends us; also recorded by the web app.
    INSTRUMENT = "instrument"
    # A folder copied into our store with its paths kept (bl demo-lab); nothing to list.
    IMPORT = "import"


class FileKind(StrEnum):
    PDF = "pdf"
    SPREADSHEET = "spreadsheet"
    DOCUMENT = "document"
    TEXT = "text"
    IMAGE = "image"
    # Only talk-throughs are transcribed; other audio is indexed by name.
    AUDIO = "audio"
    # Only videos linked to a protocol page are transcribed; others are indexed by name.
    VIDEO = "video"
    OTHER = "other"


class IndexState(StrEnum):
    PENDING = "pending"
    INDEXED = "indexed"
    FAILED = "failed"


class ExtractionKind(StrEnum):
    TEXT = "text"
    TABLE = "table"
    IMAGE_META = "image_meta"
    IMAGE_CAPTION = "image_caption"
    TRANSCRIPT = "transcript"


@dataclass(frozen=True)
class Entry:
    """One file as a source lists it."""

    external_id: str
    path: str
    name: str
    size: int
    modified_at: datetime
    source_rev: str


@dataclass(frozen=True)
class ListPage:
    entries: list[Entry]
    # Paths removed since the cursor, matched case-insensitively; a folder path removes
    # everything under it, because Dropbox reports a deleted folder as one entry.
    deleted: list[str]
    next_cursor: str | None
    has_more: bool


@dataclass(frozen=True)
class SourceRow:
    id: UUID
    lab_id: UUID
    kind: SourceKind
    root_path: str
    token_ciphertext: bytes | None
    cursor: str | None


class SourceReadError(Exception):
    """The file can't be read any more (gone, or refused); the location fails, not the job."""


class CursorExpired(Exception):
    """The source forgot the cursor; the scan starts over with a full listing."""
