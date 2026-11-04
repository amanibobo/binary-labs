from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from bl_worker.config import Settings
from bl_worker.domain import ListPage, SourceKind, SourceRow
from bl_worker.previews import PreviewStore


class Reader(Protocol):
    def read(self, external_id: str) -> bytes: ...


class Source(Reader, Protocol):
    """A place the worker lists files from. Uploads are pushed to us instead, so they only read."""

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


def build_reader(row: SourceRow, settings: Settings, store: PreviewStore) -> Reader:
    if row.kind is SourceKind.UPLOAD:
        from bl_worker.sources.upload import UploadReader

        return UploadReader(store, row.lab_id)
    return build_source(row, settings)
