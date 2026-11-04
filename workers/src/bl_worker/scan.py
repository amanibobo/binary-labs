from __future__ import annotations

import logging
from datetime import datetime
from uuid import UUID

import psycopg

from bl_worker.config import Settings
from bl_worker.domain import CursorExpired, ListPage, SourceKind, SourceRow
from bl_worker.sources import build_source

log = logging.getLogger(__name__)

# A changed revision, or a failure being retried, goes back to pending; anything else keeps
# its state, so an unchanged file is never reprocessed.
UPSERT_LOCATION = """
insert into file_locations as fl
  (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev)
values (%(lab_id)s, %(source_id)s, %(external_id)s, %(path)s, %(name)s, %(size)s,
  %(modified_at)s, %(source_rev)s)
on conflict (source_id, external_id) do update set
  path = excluded.path,
  original_name = excluded.original_name,
  size = excluded.size,
  modified_at = excluded.modified_at,
  seen_at = now(),
  deleted_at = null,
  source_rev = excluded.source_rev,
  index_state = case
    when fl.source_rev <> excluded.source_rev or fl.index_state = 'failed' then 'pending'
    else fl.index_state end,
  index_error = case
    when fl.source_rev <> excluded.source_rev or fl.index_state = 'failed' then null
    else fl.index_error end
"""

DELETE_PATH = """
update file_locations set deleted_at = now()
where source_id = %s and deleted_at is null
  and (lower(path) = %s or starts_with(lower(path), %s || '/'))
"""

DELETE_UNSEEN = """
update file_locations set deleted_at = now()
where source_id = %s and deleted_at is null and seen_at < %s
"""


# A source `s` the worker may read: it has a folder, Dropbox is still connected, and its lab
# isn't being deleted. Every job that reads a source checks this when it starts.
LIVE_SOURCE = """
s.root_path is not null and s.disconnected_at is null
and not exists (select 1 from labs l where l.id = s.lab_id and l.deletion_requested_at is not null)
"""


class ScanStopped(Exception):
    """The source was disconnected or its lab marked for deletion mid-scan."""


def load_source(conn: psycopg.Connection, source_id: UUID) -> SourceRow | None:
    row = conn.execute(
        "select s.id, s.lab_id, s.kind, s.root_path, s.token_ciphertext, s.cursor from sources s"
        f" where s.id = %s and {LIVE_SOURCE}",
        (source_id,),
    ).fetchone()
    if row is None:
        return None
    return SourceRow(row[0], row[1], SourceKind(row[2]), row[3], row[4], row[5])


def scan_source(conn: psycopg.Connection, settings: Settings, source_id: UUID) -> list[UUID]:
    """Lists the source into file_locations; returns every pending location to process."""
    row = load_source(conn, source_id)
    if row is None:
        log.info("source %s is gone, disconnected or has no folder; nothing to scan", source_id)
        return []
    (started_at,) = conn.execute(
        "update sources set scan_started_at = now(), scan_error = null where id = %s"
        " returning scan_started_at",
        (source_id,),
    ).fetchone()  # type: ignore[misc]
    try:
        cursor = _list_all(conn, row, settings, started_at)
    except ScanStopped:
        log.info("source %s was disconnected or its lab deleted; scan stopped", source_id)
        return []
    except Exception as e:
        conn.execute(
            "update sources set scan_error = %s where id = %s",
            (f"{type(e).__name__}: {e}", source_id),
        )
        raise
    pending = [
        r[0]
        for r in conn.execute(
            "select id from file_locations"
            " where source_id = %s and deleted_at is null and index_state = 'pending'"
            " order by path",
            (source_id,),
        )
    ]
    conn.execute(
        "update sources set cursor = %s, scan_finished_at = now(), scan_error = null where id = %s",
        (cursor, source_id),
    )
    return pending


def _list_all(
    conn: psycopg.Connection, row: SourceRow, settings: Settings, started_at: datetime
) -> str | None:
    source = build_source(row, settings)
    cursor = row.cursor
    full = cursor is None
    while True:
        try:
            page = source.list(cursor)
        except CursorExpired:
            log.info("source %s cursor expired; listing everything", row.id)
            cursor, full = None, True
            continue
        _apply_page(conn, row, page)
        cursor = page.next_cursor
        if not page.has_more:
            break
    if full:
        conn.execute(DELETE_UNSEEN, (row.id, started_at))
    return cursor


def _apply_page(conn: psycopg.Connection, row: SourceRow, page: ListPage) -> None:
    with conn.transaction(), conn.cursor() as cur:
        # Locking the source row orders this page against a disconnect or a lab deletion,
        # which both update it: either the page lands first, or the scan stops here.
        live = cur.execute(
            f"select 1 from sources s where s.id = %s and {LIVE_SOURCE} for share of s", (row.id,)
        ).fetchone()
        if live is None:
            raise ScanStopped
        cur.executemany(
            UPSERT_LOCATION,
            [
                {
                    "lab_id": row.lab_id,
                    "source_id": row.id,
                    "external_id": e.external_id,
                    "path": e.path,
                    "name": e.name,
                    "size": e.size,
                    "modified_at": e.modified_at,
                    "source_rev": e.source_rev,
                }
                for e in page.entries
            ],
        )
        for path in page.deleted:
            p = path.lower().rstrip("/")
            cur.execute(DELETE_PATH, (row.id, p, p))
