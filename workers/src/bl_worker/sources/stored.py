from __future__ import annotations

import hashlib
from uuid import UUID

from bl_worker.domain import SourceReadError
from bl_worker.previews import PreviewStore, file_key


class StoredReader:
    """Files we hold in our object store, uploads and instrument files, read by their sha256."""

    def __init__(self, store: PreviewStore, lab_id: UUID) -> None:
        self.store = store
        self.lab_id = lab_id

    def read(self, sha256: str) -> bytes:
        data = self.store.get(file_key(self.lab_id, sha256))
        if data is None:
            raise SourceReadError(f"{sha256}: not in the object store")
        if hashlib.sha256(data).hexdigest() != sha256:
            raise SourceReadError(f"{sha256}: stored bytes don't match their hash")
        return data
