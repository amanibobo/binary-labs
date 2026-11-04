from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

from bl_worker.domain import Entry, ListPage, SourceReadError


class LocalFolderSource:
    """A folder on this machine. Always lists everything; the scan diffs seen_at for deletions."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()

    def list(self, cursor: str | None) -> ListPage:
        entries: list[Entry] = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for name in sorted(filenames):
                full = Path(dirpath) / name
                if name.startswith(".") or full.is_symlink():
                    continue
                st = full.stat()
                rel = full.relative_to(self.root).as_posix()
                entries.append(
                    Entry(
                        external_id=rel,
                        path="/" + rel,
                        name=name,
                        size=st.st_size,
                        modified_at=datetime.fromtimestamp(st.st_mtime_ns / 1e9, UTC),
                        source_rev=f"{st.st_size}:{st.st_mtime_ns}",
                    )
                )
        return ListPage(entries=entries, deleted=[], next_cursor=None, has_more=False)

    def read(self, external_id: str) -> bytes:
        try:
            return (self.root / external_id).read_bytes()
        except (FileNotFoundError, IsADirectoryError, PermissionError) as e:
            raise SourceReadError(f"{external_id}: {e.strerror}") from e
