from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID


class SourceKind(StrEnum):
    DROPBOX = "dropbox"
    LOCAL = "local"


class FileKind(StrEnum):
    PDF = "pdf"
    SPREADSHEET = "spreadsheet"
    DOCUMENT = "document"
    TEXT = "text"
    IMAGE = "image"
    OTHER = "other"


class IndexState(StrEnum):
    PENDING = "pending"
    INDEXED = "indexed"
    FAILED = "failed"


class ExtractionKind(StrEnum):
    TEXT = "text"
    TABLE = "table"
    IMAGE_META = "image_meta"


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
