"""A lab's parsed tables, for charts (decisions.md, "data sheet to chart").

A spreadsheet's tables are parsed while the file is processed, since its bytes are in hand
then. A file indexed before charts existed, or one whose table failed, gets a data_tables row
in "waiting" when someone opens the chart builder on it; tend_tables reads it again and parses
it. Each lab keeps its own copy under <lab_id>/tables/, so deleting the lab's prefix removes it.
"""

from __future__ import annotations

import hashlib
import logging
from uuid import UUID

import psycopg

from bl_worker import tables
from bl_worker.db import lab_lock
from bl_worker.domain import SourceKind, SourceReadError, SourceRow
from bl_worker.previews import PreviewStore, lab_prefix
from bl_worker.runtime import Runtime
from bl_worker.scan import LIVE_SOURCE
from bl_worker.sources import read_file

log = logging.getLogger(__name__)


def table_key(lab_id: object, sha256: str) -> str:
    return f"{lab_prefix(lab_id)}tables/{sha256}.json"


def build(
    conn: psycopg.Connection, store: PreviewStore, lab_id: UUID, sha256: str, data: bytes
) -> str:
    """Parses and stores the file's tables unless this parser version already did; returns the
    row's state. A file whose bytes aren't a table fails its row, never the file or the job."""
    with conn.transaction():
        conn.execute(
            "select pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"table:{lab_id}:{sha256}",)
        )
        row = conn.execute(
            "select state, parser_version from data_tables where lab_id = %s and sha256 = %s",
            (lab_id, sha256),
        ).fetchone()
        if row is not None and row[0] == "ready" and row[1] == tables.VERSION:
            return "ready"
        try:
            parsed = tables.parse(data)
        except tables.TableFailed as e:
            log.info("no table in %s: %s", sha256[:12], e)
            _settle(conn, lab_id, sha256, error=f"We couldn't read a table in this file. {e}")
            return "failed"
        key = table_key(lab_id, sha256)
        store.put(key, parsed.to_json(), "application/json")
        _settle(conn, lab_id, sha256, key=key)
    log.info("table of %s: %d tables", sha256[:12], len(parsed.tables))
    return "ready"


def _settle(
    conn: psycopg.Connection,
    lab_id: UUID,
    sha256: str,
    *,
    key: str | None = None,
    error: str | None = None,
) -> None:
    conn.execute(
        "insert into data_tables (lab_id, sha256, state, parser_version, storage_key, error)"
        " values (%(lab)s, %(sha)s, %(state)s, %(version)s, %(key)s, %(error)s)"
        " on conflict (lab_id, sha256) do update set state = excluded.state,"
        " parser_version = excluded.parser_version, storage_key = excluded.storage_key,"
        " error = excluded.error, updated_at = now()",
        {
            "lab": lab_id,
            "sha": sha256,
            "state": "ready" if key is not None else "failed",
            "version": tables.VERSION,
            "key": key,
            "error": error[:500] if error is not None else None,
        },
    )


def waiting(conn: psycopg.Connection) -> list[tuple[UUID, str]]:
    rows = conn.execute(
        "select lab_id, sha256 from data_tables where state = 'waiting' order by requested_at"
    )
    return [(r[0], r[1]) for r in rows]


def parse_waiting(rt: Runtime, lab_id: UUID, sha256: str) -> str | None:
    """Reads a waiting file from where it lives and parses it; None when nothing waits."""
    with rt.pool.connection() as conn, lab_lock(conn, lab_id, exclusive=False):
        found = conn.execute(
            "select 1 from data_tables where lab_id = %s and sha256 = %s and state = 'waiting'",
            (lab_id, sha256),
        ).fetchone()
        if found is None:
            return None
        located = conn.execute(
            f"""
            select fl.external_id, s.id, s.lab_id, s.kind, s.root_path, s.token_ciphertext,
              s.cursor
            from file_locations fl join sources s on s.id = fl.source_id
            where fl.lab_id = %s and fl.sha256 = %s and fl.deleted_at is null and {LIVE_SOURCE}
            order by s.kind::text in ('upload', 'instrument') desc, fl.path limit 1
            """,
            (lab_id, sha256),
        ).fetchone()
        if located is None:
            _settle_failed(conn, lab_id, sha256, "This file can't be read right now.")
            return "failed"
        source = SourceRow(
            located[1], located[2], SourceKind(located[3]), located[4], located[5], located[6]
        )
        try:
            data = read_file(source, rt.settings, rt.previews, located[0], sha256)
        except SourceReadError as e:
            _settle_failed(conn, lab_id, sha256, f"This file can't be read right now. {e}")
            return "failed"
        if hashlib.sha256(data).hexdigest() != sha256:
            _settle_failed(conn, lab_id, sha256, "This file changed since it was indexed.")
            return "failed"
        return build(conn, rt.previews, lab_id, sha256, data)


def _settle_failed(conn: psycopg.Connection, lab_id: UUID, sha256: str, error: str) -> None:
    with conn.transaction():
        _settle(conn, lab_id, sha256, error=error)
