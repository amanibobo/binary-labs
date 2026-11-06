"""A lab's parsed tables, for charts (decisions.md, "data sheet to chart").

A spreadsheet's tables are parsed while the file is processed, since its bytes are in hand
then. A file indexed before charts existed, or one whose table failed, gets a data_tables row
in "waiting" when someone opens the chart builder on it; tend_tables reads it again and parses
it. Each lab keeps its own copy under <lab_id>/tables/, so deleting the lab's prefix removes it.

When the parser's version rises, sweep_stale_tables re-parses stored tables a few at a time,
those used longest ago first (decisions.md, "re-parsing tables"). The new JSON goes to its own
key and the row moves to it in one transaction, so a reader always finds a whole table, old or
new. A re-parse that fails keeps the old table and records why on the row.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from uuid import UUID

import psycopg
from psycopg import pq

from bl_worker import tables
from bl_worker.db import lab_lock
from bl_worker.domain import SourceKind, SourceReadError, SourceRow
from bl_worker.previews import PreviewStore, lab_prefix
from bl_worker.runtime import Runtime
from bl_worker.scan import LIVE_SOURCE
from bl_worker.sources import read_file

log = logging.getLogger(__name__)

# How many stale tables one sweep queues. A sweep runs every minute, so a lab's tables move to
# a new parser at about 600 an hour, each a download from where the file lives; small enough
# not to crowd out new files, which are parsed as they're processed.
REPARSE_BATCH = 10


def table_key(lab_id: object, sha256: str, version: int = tables.VERSION) -> str:
    """Version 1 tables live at <sha256>.json; later ones carry their version, so a re-parse
    never overwrites the table a reader may be fetching."""
    suffix = "" if version == 1 else f".v{version}"
    return f"{lab_prefix(lab_id)}tables/{sha256}{suffix}.json"


@dataclass(frozen=True)
class _Row:
    state: str
    version: int | None
    key: str | None


def _row(conn: psycopg.Connection, lab_id: UUID, sha256: str) -> _Row | None:
    row = conn.execute(
        "select state, parser_version, storage_key from data_tables"
        " where lab_id = %s and sha256 = %s",
        (lab_id, sha256),
    ).fetchone()
    return _Row(row[0], row[1], row[2]) if row else None


def build(
    conn: psycopg.Connection, store: PreviewStore, lab_id: UUID, sha256: str, data: bytes
) -> str:
    """Parses and stores the file's tables unless this parser version already did; returns the
    row's state. A file whose bytes aren't a table fails its row, never the file or the job,
    except that a table already read by an older parser is kept, with the failure noted."""
    replaced: str | None = None
    with conn.transaction():
        conn.execute(
            "select pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"table:{lab_id}:{sha256}",)
        )
        row = _row(conn, lab_id, sha256)
        if row is not None and row.state == "ready" and row.version == tables.VERSION:
            return "ready"
        try:
            parsed = tables.parse(data)
        except tables.TableFailed as e:
            log.info("no table in %s: %s", sha256[:12], e)
            if row is not None and row.state == "ready":
                _note_reparse_failed(conn, lab_id, sha256, f"{e}")
                return "ready"
            _settle(conn, lab_id, sha256, error=f"We couldn't read a table in this file. {e}")
            return "failed"
        key = table_key(lab_id, sha256)
        store.put(key, parsed.to_json(), "application/json")
        _settle(conn, lab_id, sha256, key=key)
        if row is not None and row.key is not None and row.key != key:
            replaced = row.key
    # The old table goes once the row points at the new one for everyone, which inside a
    # caller's own transaction isn't yet.
    if replaced is not None and conn.info.transaction_status == pq.TransactionStatus.IDLE:
        store.delete_prefix(replaced)
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
        " error = excluded.error, reparse_version = null, reparse_error = null,"
        " updated_at = now()",
        {
            "lab": lab_id,
            "sha": sha256,
            "state": "ready" if key is not None else "failed",
            "version": tables.VERSION,
            "key": key,
            "error": error[:500] if error is not None else None,
        },
    )


def _note_reparse_failed(conn: psycopg.Connection, lab_id: UUID, sha256: str, why: str) -> None:
    """A newer parser couldn't read a table an older one did: the old table stays, and the row
    says which version tried and why, so the sweep doesn't try again until the next version."""
    conn.execute(
        "update data_tables set reparse_version = %s, reparse_error = %s, updated_at = now()"
        " where lab_id = %s and sha256 = %s",
        (tables.VERSION, why[:500], lab_id, sha256),
    )


def waiting(conn: psycopg.Connection) -> list[tuple[UUID, str]]:
    rows = conn.execute(
        "select lab_id, sha256 from data_tables where state = 'waiting' order by requested_at"
    )
    return [(r[0], r[1]) for r in rows]


def _read(rt: Runtime, conn: psycopg.Connection, lab_id: UUID, sha256: str) -> bytes | str:
    """The file's bytes from a live place it lives, or why they can't be had."""
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
        return "This file can't be read right now."
    source = SourceRow(
        located[1], located[2], SourceKind(located[3]), located[4], located[5], located[6]
    )
    try:
        data = read_file(source, rt.settings, rt.previews, located[0], sha256)
    except SourceReadError as e:
        return f"This file can't be read right now. {e}"
    if hashlib.sha256(data).hexdigest() != sha256:
        return "This file changed since it was indexed."
    return data


def parse_waiting(rt: Runtime, lab_id: UUID, sha256: str) -> str | None:
    """Reads a waiting file from where it lives and parses it; None when nothing waits."""
    with rt.pool.connection() as conn, lab_lock(conn, lab_id, exclusive=False):
        found = conn.execute(
            "select 1 from data_tables where lab_id = %s and sha256 = %s and state = 'waiting'",
            (lab_id, sha256),
        ).fetchone()
        if found is None:
            return None
        data = _read(rt, conn, lab_id, sha256)
        if isinstance(data, str):
            _settle_failed(conn, lab_id, sha256, data)
            return "failed"
        return build(conn, rt.previews, lab_id, sha256, data)


def _settle_failed(conn: psycopg.Connection, lab_id: UUID, sha256: str, error: str) -> None:
    with conn.transaction():
        _settle(conn, lab_id, sha256, error=error)


# Ready or failed tables an older parser read, which this version hasn't tried, in labs that
# aren't being deleted: those used longest ago first. A table's last use is the later of when
# it was asked for (or first parsed) and when a chart of it was last saved.
STALE = """
select t.lab_id, t.sha256 from data_tables t join labs l on l.id = t.lab_id
where t.state in ('ready', 'failed') and t.parser_version < %(version)s
  and coalesce(t.reparse_version, 0) < %(version)s and l.deletion_requested_at is null
order by greatest(
  t.requested_at,
  (select max(c.updated_at) from charts c where c.lab_id = t.lab_id and c.sha256 = t.sha256)
), t.sha256
limit %(limit)s
"""


def stale(conn: psycopg.Connection, limit: int = REPARSE_BATCH) -> list[tuple[UUID, str]]:
    rows = conn.execute(STALE, {"version": tables.VERSION, "limit": limit})
    return [(r[0], r[1]) for r in rows]


@dataclass(frozen=True)
class Progress:
    """How far a lab's tables have got to this parser version, across every lab."""

    current: int
    stale: int
    kept: int  # an older table kept because this version couldn't read the file

    def __str__(self) -> str:
        return f"{self.current} at v{tables.VERSION}, {self.stale} to go, {self.kept} kept old"


def progress(conn: psycopg.Connection) -> Progress:
    row = conn.execute(
        "select count(*) filter (where parser_version = %(v)s),"
        " count(*) filter (where parser_version < %(v)s and coalesce(reparse_version, 0) < %(v)s),"
        " count(*) filter (where reparse_version = %(v)s)"
        " from data_tables where state in ('ready', 'failed')",
        {"v": tables.VERSION},
    ).fetchone()
    assert row is not None
    return Progress(row[0], row[1], row[2])


def reparse(rt: Runtime, lab_id: UUID, sha256: str) -> str | None:
    """Reads one stale table's file again with this parser. Safe to re-run or stop: a table
    already at this version, or already tried by it, is left alone, and the old table stays
    until the new one is stored. None when there's nothing to do."""
    with rt.pool.connection() as conn, lab_lock(conn, lab_id, exclusive=False):
        found = conn.execute(
            "select state from data_tables where lab_id = %s and sha256 = %s"
            " and state in ('ready', 'failed') and parser_version < %s"
            " and coalesce(reparse_version, 0) < %s",
            (lab_id, sha256, tables.VERSION, tables.VERSION),
        ).fetchone()
        if found is None:
            return None
        data = _read(rt, conn, lab_id, sha256)
        if isinstance(data, str):
            if found[0] == "ready":
                with conn.transaction():
                    _note_reparse_failed(conn, lab_id, sha256, data)
                return "kept"
            _settle_failed(conn, lab_id, sha256, data)
            return "failed"
        state = build(conn, rt.previews, lab_id, sha256, data)
        row = _row(conn, lab_id, sha256)
        return (
            "kept"
            if state == "ready" and row is not None and row.version != tables.VERSION
            else state
        )
