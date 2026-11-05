from __future__ import annotations

import hashlib
from uuid import UUID

from bl_worker.domain import SourceReadError
from bl_worker.previews import PreviewStore, file_key


class UploadReader:
    """Uploaded files in our object store. An upload's external_id is its sha256."""

    def __init__(self, store: PreviewStore, lab_id: UUID) -> None:
        self.store = store
        self.lab_id = lab_id

    def read(self, external_id: str) -> bytes:
        data = self.store.get(file_key(self.lab_id, external_id))
        if data is None:
            raise SourceReadError(f"{external_id}: not in the object store")
        if hashlib.sha256(data).hexdigest() != external_id:
            raise SourceReadError(f"{external_id}: stored bytes don't match their hash")
        return data
