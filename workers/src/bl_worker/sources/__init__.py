from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from bl_worker.config import Settings
from bl_worker.domain import ListPage, SourceKind, SourceRow


class Source(Protocol):
    def list(self, cursor: str | None) -> ListPage: ...

    def read(self, external_id: str) -> bytes: ...


def _local(row: SourceRow, settings: Settings) -> Source:
    from bl_worker.sources.local import LocalFolderSource

    return LocalFolderSource(row.root_path)


def _dropbox(row: SourceRow, settings: Settings) -> Source:
    from bl_worker.sources.dropbox import DropboxSource

    return DropboxSource.from_row(row, settings)


SOURCE_FACTORIES: dict[SourceKind, Callable[[SourceRow, Settings], Source]] = {
    SourceKind.LOCAL: _local,
    SourceKind.DROPBOX: _dropbox,
}


def build_source(row: SourceRow, settings: Settings) -> Source:
    return SOURCE_FACTORIES[row.kind](row, settings)
