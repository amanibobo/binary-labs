from __future__ import annotations

import base64
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import psycopg
import pytest

from bl_worker import process, scan
from bl_worker.config import Settings
from bl_worker.db import migrate
from bl_worker.embed import HashEmbedder
from bl_worker.runtime import Runtime, build_runtime

ADMIN_URL = "postgresql://localhost/postgres"
TEST_DB = "binary_labs_worker_test"
TEST_URL = f"postgresql://localhost/{TEST_DB}"
KEY = bytes(range(32))


def _drop(conn: psycopg.Connection) -> None:
    conn.execute(f"drop database if exists {TEST_DB} with (force)")


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        _drop(admin)
        admin.execute(f"create database {TEST_DB}")
    migrate(TEST_URL, test_stub=True)
    yield TEST_URL
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        _drop(admin)


@pytest.fixture
def settings(database_url: str, tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        database_url=database_url,
        token_encryption_key=base64.b64encode(KEY).decode(),  # type: ignore[arg-type]
        embed_model="hash-1024",
        preview_store="local",
        preview_dir=tmp_path / "previews",
    )


@pytest.fixture
def rt(settings: Settings) -> Iterator[Runtime]:
    runtime = build_runtime(settings, embedder=HashEmbedder())
    with runtime.pool.connection() as conn:
        conn.execute(
            "truncate labs, blobs, auth.users, procrastinate_jobs,"
            " procrastinate_periodic_defers, procrastinate_workers cascade"
        )
    yield runtime
    runtime.close()


@pytest.fixture
def conn(rt: Runtime) -> Iterator[psycopg.Connection]:
    with rt.pool.connection() as c:
        yield c


@dataclass(frozen=True)
class Lab:
    id: uuid.UUID
    user_id: uuid.UUID
    source_id: uuid.UUID
    folder: Path

    def write(self, rel: str, data: bytes | str) -> Path:
        path = self.folder / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data.encode() if isinstance(data, str) else data)
        return path


@pytest.fixture
def make_lab(conn: psycopg.Connection, tmp_path: Path):
    def make(name: str = "lab") -> Lab:
        user_id = uuid.uuid4()
        folder = tmp_path / f"{name}-{user_id.hex[:6]}"
        folder.mkdir()
        conn.execute(
            "insert into auth.users (id, email) values (%s, %s)", (user_id, f"{user_id}@x.edu")
        )
        (lab_id,) = conn.execute(
            "insert into labs (name) values (%s) returning id", (name,)
        ).fetchone()  # type: ignore[misc]
        conn.execute(
            "insert into members (lab_id, user_id, role) values (%s, %s, 'admin')",
            (lab_id, user_id),
        )
        (source_id,) = conn.execute(
            "insert into sources (lab_id, kind, root_path) values (%s, 'local', %s) returning id",
            (lab_id, str(folder)),
        ).fetchone()  # type: ignore[misc]
        return Lab(lab_id, user_id, source_id, folder)

    return make


def run_scan(rt: Runtime, source_id: uuid.UUID) -> list[process.Outcome]:
    """One scan_source job, then every process_location job it would defer."""
    with rt.pool.connection() as c:
        pending = scan.scan_source(c, rt.settings, source_id)
    return [process.process_location(rt, loc) for loc in pending]


def search(
    conn: psycopg.Connection, lab_id: uuid.UUID, query: str, embedding: list[float] | None
) -> list[dict]:
    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        return cur.execute(
            "select * from search_files(%s, %s, %s::vector)", (lab_id, query, embedding)
        ).fetchall()


@contextmanager
def as_user(conn: psycopg.Connection, user_id: uuid.UUID) -> Iterator[psycopg.Connection]:
    """Runs as Supabase's `authenticated` role with the JWT subject set, so RLS applies."""
    with conn.transaction(force_rollback=True):
        conn.execute("set local role authenticated")
        conn.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(user_id),))
        yield conn


@contextmanager
def committed_as_user(conn: psycopg.Connection, user_id: uuid.UUID) -> Iterator[psycopg.Connection]:
    """Like as_user, but commits, for fixtures that act as a member."""
    with conn.transaction():
        conn.execute("set local role authenticated")
        conn.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(user_id),))
        yield conn
