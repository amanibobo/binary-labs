from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx

from bl_worker.config import Settings
from bl_worker.crypto import decrypt_token
from bl_worker.domain import CursorExpired, Entry, ListPage, SourceReadError, SourceRow

# The only endpoints this package may call, kept as whole literals so
# tests/test_dropbox.py can check every Dropbox URL in the code against a read-only list.
TOKEN_URL = "https://api.dropboxapi.com/oauth2/token"
LIST_FOLDER = "https://api.dropboxapi.com/2/files/list_folder"
LIST_FOLDER_CONTINUE = "https://api.dropboxapi.com/2/files/list_folder/continue"
DOWNLOAD = "https://content.dropboxapi.com/2/files/download"

MAX_ATTEMPTS = 5


@dataclass
class _AccessToken:
    value: str
    expires_at: float


class DropboxSource:
    """Read-only. `external_id` is the Dropbox file id, `source_rev` its content_hash."""

    def __init__(
        self,
        root_path: str,
        refresh_token: str,
        app_key: str,
        app_secret: str,
        client: httpx.Client | None = None,
    ) -> None:
        self.root_path = "" if root_path in ("", "/") else root_path.rstrip("/")
        self._refresh_token = refresh_token
        self._app_key = app_key
        self._app_secret = app_secret
        self._client = client or httpx.Client(timeout=60)
        self._token: _AccessToken | None = None

    @classmethod
    def from_row(cls, row: SourceRow, settings: Settings) -> DropboxSource:
        if not (settings.dropbox_app_key and settings.dropbox_app_secret):
            raise RuntimeError("a dropbox source needs DROPBOX_APP_KEY and DROPBOX_APP_SECRET")
        if settings.token_encryption_key is None:
            raise RuntimeError("a dropbox source needs TOKEN_ENCRYPTION_KEY")
        assert row.token_ciphertext is not None  # a check constraint on sources guarantees it
        return cls(
            root_path=row.root_path,
            refresh_token=decrypt_token(settings.token_encryption_key, row.token_ciphertext),
            app_key=settings.dropbox_app_key,
            app_secret=settings.dropbox_app_secret.get_secret_value(),
        )

    def list(self, cursor: str | None) -> ListPage:
        if cursor is None:
            body = self._call(LIST_FOLDER, json={"path": self.root_path, "recursive": True})
        else:
            try:
                body = self._call(LIST_FOLDER_CONTINUE, json={"cursor": cursor})
            except _ApiError as e:
                if e.summary.startswith("reset"):
                    raise CursorExpired from e
                raise
        data = body.json()
        entries: list[Entry] = []
        deleted: list[str] = []
        for item in data["entries"]:
            tag = item[".tag"]
            if tag == "file":
                entries.append(_entry(item))
            elif tag == "deleted":
                deleted.append(item["path_lower"])
        return ListPage(
            entries=entries,
            deleted=deleted,
            next_cursor=data["cursor"],
            has_more=data["has_more"],
        )

    def read(self, external_id: str) -> bytes:
        try:
            resp = self._call(
                DOWNLOAD, headers={"Dropbox-API-Arg": json.dumps({"path": external_id})}
            )
        except _ApiError as e:
            raise SourceReadError(f"{external_id}: {e.summary}") from e
        return resp.content

    def _access_token(self) -> str:
        if self._token is None or self._token.expires_at - 60 < time.monotonic():
            resp = self._client.post(
                TOKEN_URL,
                data={"grant_type": "refresh_token", "refresh_token": self._refresh_token},
                auth=(self._app_key, self._app_secret),
            )
            resp.raise_for_status()
            data = resp.json()
            self._token = _AccessToken(
                value=data["access_token"],
                expires_at=time.monotonic() + float(data.get("expires_in", 14400)),
            )
        return self._token.value

    def _call(self, url: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}))
        for attempt in range(MAX_ATTEMPTS):
            headers["Authorization"] = f"Bearer {self._access_token()}"
            resp = self._client.post(url, headers=headers, **kwargs)
            if resp.status_code == 401 and attempt == 0:
                self._token = None
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                time.sleep(float(resp.headers.get("Retry-After", 2**attempt)))
                continue
            if resp.status_code == 409:
                raise _ApiError(resp.json().get("error_summary", ""))
            resp.raise_for_status()
            return resp
        resp.raise_for_status()
        return resp


class _ApiError(Exception):
    def __init__(self, summary: str) -> None:
        super().__init__(summary)
        self.summary = summary


def _entry(item: dict[str, Any]) -> Entry:
    return Entry(
        external_id=item["id"],
        path=item["path_display"],
        name=item["name"],
        size=item["size"],
        modified_at=datetime.fromisoformat(item["server_modified"]),
        source_rev=item["content_hash"],
    )
