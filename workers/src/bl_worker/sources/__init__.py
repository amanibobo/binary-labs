from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from bl_worker.config import Settings
from bl_worker.domain import ListPage, SourceKind, SourceRow
from bl_worker.previews import PreviewStore


class Reader(Protocol):
    def read(self, external_id: str) -> bytes: ...


class Source(Reader, Protocol):
    """A place the worker lists files from. Uploads and instrument files are pushed to us
    instead, so they only read."""

    def list(self, cursor: str | None) -> ListPage: ...


def _local(row: SourceRow, settings: Settings) -> Source:
    from bl_worker.sources.local import LocalFolderSource

    return LocalFolderSource(row.root_path)


def _dropbox(row: SourceRow, settings: Settings) -> Source:
    from bl_worker.sources.dropbox import DropboxSource

    return DropboxSource.from_row(row, settings)


LISTED_SOURCES: dict[SourceKind, Callable[[SourceRow, Settings], Source]] = {
    SourceKind.LOCAL: _local,
    SourceKind.DROPBOX: _dropbox,
}


def is_listed(kind: SourceKind) -> bool:
    return kind in LISTED_SOURCES


def build_source(row: SourceRow, settings: Settings) -> Source:
    return LISTED_SOURCES[row.kind](row, settings)


# Sources whose bytes we hold, at <lab_id>/files/<sha256>; a location's source_rev is that sha256.
STORED_SOURCES = frozenset({SourceKind.UPLOAD, SourceKind.INSTRUMENT, SourceKind.IMPORT})


def read_file(
    row: SourceRow, settings: Settings, store: PreviewStore, external_id: str, source_rev: str
) -> bytes:
    if row.kind in STORED_SOURCES:
        from bl_worker.sources.stored import StoredReader

        return StoredReader(store, row.lab_id).read(source_rev)
    return build_source(row, settings).read(external_id)
