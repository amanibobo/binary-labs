import base64
import json
import re
import uuid
from pathlib import Path

import httpx
import pytest

import bl_worker
from bl_worker.config import Settings
from bl_worker.crypto import encrypt_token
from bl_worker.domain import CursorExpired, SourceKind, SourceReadError, SourceRow
from bl_worker.sources import build_source
from bl_worker.sources.dropbox import DropboxSource

PACKAGE = Path(bl_worker.__file__).parent
ALLOWED_DROPBOX_URLS = {
    "https://api.dropboxapi.com/oauth2/token",
    "https://api.dropboxapi.com/2/files/list_folder",
    "https://api.dropboxapi.com/2/files/list_folder/continue",
    "https://content.dropboxapi.com/2/files/download",
}


def _file(id_, path, rev, size=5):
    return {
        ".tag": "file",
        "id": id_,
        "name": path.rsplit("/", 1)[-1],
        "path_display": path,
        "path_lower": path.lower(),
        "size": size,
        "server_modified": "2026-10-14T15:32:01Z",
        "content_hash": rev,
    }


class FakeDropbox:
    def __init__(self):
        self.calls: list[httpx.Request] = []
        self.tokens_minted = 0
        self.expire_first_token = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        url = str(request.url)
        if url.endswith("/oauth2/token"):
            self.tokens_minted += 1
            return httpx.Response(
                200, json={"access_token": f"at-{self.tokens_minted}", "expires_in": 14400}
            )
        if self.expire_first_token and request.headers["Authorization"] == "Bearer at-1":
            return httpx.Response(401, json={"error_summary": "expired_access_token/"})
        body = json.loads(request.content) if request.content else {}
        if url.endswith("/2/files/list_folder"):
            assert body == {"path": "/Lab", "recursive": True}
            return httpx.Response(
                200,
                json={
                    "entries": [
                        {".tag": "folder", "name": "AB", "path_lower": "/lab/ab", "id": "id:f"},
                        _file("id:1", "/Lab/AB/gel.jpg", "h1"),
                    ],
                    "cursor": "c1",
                    "has_more": True,
                },
            )
        if url.endswith("/2/files/list_folder/continue"):
            if body["cursor"] == "stale":
                return httpx.Response(409, json={"error_summary": "reset/..."})
            return httpx.Response(
                200,
                json={
                    "entries": [
                        _file("id:2", "/Lab/final_v2_REAL.xlsx", "h2"),
                        {".tag": "deleted", "name": "old", "path_lower": "/lab/old"},
                    ],
                    "cursor": "c2",
                    "has_more": False,
                },
            )
        if url.endswith("/2/files/download"):
            arg = json.loads(request.headers["Dropbox-API-Arg"])
            if arg["path"] == "id:missing":
                return httpx.Response(409, json={"error_summary": "path/not_found/"})
            return httpx.Response(200, content=b"bytes of " + arg["path"].encode())
        return httpx.Response(404)


def _source(fake: FakeDropbox) -> DropboxSource:
    return DropboxSource(
        "/Lab/",
        "refresh-xyz",
        "app-key",
        "app-secret",
        httpx.Client(transport=httpx.MockTransport(fake)),
    )


def test_lists_files_across_pages_with_ids_hashes_and_deletions():
    fake = FakeDropbox()
    source = _source(fake)

    first = source.list(None)
    second = source.list(first.next_cursor)

    assert [(e.external_id, e.path, e.source_rev) for e in first.entries] == [
        ("id:1", "/Lab/AB/gel.jpg", "h1")
    ]
    assert first.has_more and first.next_cursor == "c1"
    assert [e.external_id for e in second.entries] == ["id:2"]
    assert second.deleted == ["/lab/old"]
    assert not second.has_more and second.next_cursor == "c2"


def test_mints_one_access_token_from_the_refresh_token_with_app_credentials():
    fake = FakeDropbox()
    source = _source(fake)
    source.list(None)
    source.read("id:1")

    token_calls = [c for c in fake.calls if str(c.url).endswith("/oauth2/token")]
    assert len(token_calls) == 1
    assert token_calls[0].content == b"grant_type=refresh_token&refresh_token=refresh-xyz"
    expected = base64.b64encode(b"app-key:app-secret").decode()
    assert token_calls[0].headers["Authorization"] == f"Basic {expected}"
    api_calls = [c for c in fake.calls if "/2/" in str(c.url)]
    assert {c.headers["Authorization"] for c in api_calls} == {"Bearer at-1"}


def test_remints_once_when_the_access_token_is_rejected():
    fake = FakeDropbox()
    fake.expire_first_token = True
    assert _source(fake).list(None).entries[0].external_id == "id:1"
    assert fake.tokens_minted == 2


def test_expired_cursor_and_missing_files_surface_as_domain_errors():
    source = _source(FakeDropbox())
    with pytest.raises(CursorExpired):
        source.list("stale")
    with pytest.raises(SourceReadError):
        source.read("id:missing")
    assert source.read("id:1") == b"bytes of id:1"


def test_registry_builds_a_dropbox_source_with_the_decrypted_refresh_token():
    key = bytes(range(32))
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        database_url="postgresql://unused",
        token_encryption_key=base64.b64encode(key).decode(),  # type: ignore[arg-type]
        dropbox_app_key="k",
        dropbox_app_secret="s",  # type: ignore[arg-type]
        preview_store="local",
    )
    row = SourceRow(
        uuid.uuid4(), uuid.uuid4(), SourceKind.DROPBOX, "/", encrypt_token(key, "sl.r"), None
    )
    source = build_source(row, settings)
    assert isinstance(source, DropboxSource)
    assert source._refresh_token == "sl.r"
    assert source.root_path == ""


def test_package_calls_no_dropbox_endpoint_that_writes():
    code = "\n".join(p.read_text() for p in PACKAGE.rglob("*.py"))
    write_words = re.findall(
        r"(?:files|sharing|file_requests|paper)[/_](?:upload\w*|move\w*|delete\w*|copy\w*"
        r"|create_folder\w*|permanently_delete|restore|save_url|add_\w+|update\w*)",
        code,
    )
    assert write_words == []
    # Every Dropbox URL in the code must be on the read-only list.
    urls = set(re.findall(r"https://[\w.]*dropbox(?:api)?\.com[\w/]*", code))
    assert urls and urls <= ALLOWED_DROPBOX_URLS
