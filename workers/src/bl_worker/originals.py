"""Every version of a file keeps its own bytes, unchanged, in our store at
<lab_id>/files/<sha256>, where uploads already are (decisions.md, "the lab drive: every
version keeps its original"). Nothing here writes to a source."""

from __future__ import annotations

import hashlib
import logging
from enum import StrEnum
from uuid import UUID

import psycopg

from bl_worker.db import lab_lock
from bl_worker.domain import SourceKind, SourceReadError, SourceRow
from bl_worker.previews import PreviewStore, file_key
from bl_worker.runtime import Runtime
from bl_worker.scan import LIVE_SOURCE
from bl_worker.sources import STORED_SOURCES, read_file

log = logging.getLogger(__name__)

# How many files one sweep queues: each is a download from where the file lives, and new
# files, kept as they're processed, shouldn't wait behind the backlog.
SWEEP_BATCH = 20


def keep(
    conn: psycopg.Connection,
    store: PreviewStore,
    lab_id: UUID,
    sha256: str,
    data: bytes,
    mime: str,
    kind: SourceKind,
) -> bool:
    """Keeps `data`, whose sha256 the caller has just computed or checked, for every version
    of this content in the lab. One object per content: a copy elsewhere or a later version
    with the same bytes shares it. Safe to run again; returns whether it stored anything."""
    waiting = conn.execute(
        "select 1 from file_versions where lab_id = %s and sha256 = %s and kept_at is null limit 1",
        (lab_id, sha256),
    ).fetchone()
    if waiting is None:
        return False
    held = (
        kind in STORED_SOURCES
        or conn.execute(
            "select 1 from file_versions where lab_id = %s and sha256 = %s"
            " and kept_at is not null limit 1",
            (lab_id, sha256),
        ).fetchone()
        is not None
    )
    # A file read from our store came from this very key, with its hash checked on the way.
    if not held:
        store.put(file_key(lab_id, sha256), data, mime)
    # Marked only after the bytes are in, so a crash between the two is retried, not believed.
    conn.execute(
        "update file_versions set kept_at = now() where lab_id = %s and sha256 = %s"
        " and kept_at is null",
        (lab_id, sha256),
    )
    return not held


# Versions with no bytes kept whose content is still what their place holds, so it can be
# read again: the files read before originals were kept. Largest backlog first is no better
# than any other order, so oldest first.
WAITING = f"""
select fv.location_id
from file_versions fv
join file_locations fl on fl.id = fv.location_id
join sources s on s.id = fl.source_id
where fv.kept_at is null
  and fl.sha256 = fv.sha256
  and fl.deleted_at is null
  and fl.index_state = 'indexed'
  and {LIVE_SOURCE}
order by fv.seen_at, fv.id
limit %s
"""


def waiting(conn: psycopg.Connection, limit: int = SWEEP_BATCH) -> list[UUID]:
    return [r[0] for r in conn.execute(WAITING, (limit,))]


class Kept(StrEnum):
    KEPT = "kept"
    # Nothing to do: already kept, deleted, or the source can't be read now.
    SKIPPED = "skipped"
    # The place holds other bytes than the version says; the next scan records them.
    CHANGED = "changed"


def keep_location(rt: Runtime, location_id: UUID) -> Kept:
    """Reads a file's current content from its source again and keeps it."""
    with rt.pool.connection() as conn:
        row = conn.execute(
            f"""
            select fl.lab_id, fl.external_id, fl.source_rev, fl.sha256, b.mime,
              s.id, s.lab_id, s.kind, s.root_path, s.token_ciphertext, s.cursor
            from file_locations fl
            join sources s on s.id = fl.source_id
            join blobs b on b.sha256 = fl.sha256
            where fl.id = %s and fl.deleted_at is null and fl.index_state = 'indexed'
              and {LIVE_SOURCE}
              and exists (
                select 1 from file_versions fv
                where fv.location_id = fl.id and fv.sha256 = fl.sha256 and fv.kept_at is null
              )
            """,
            (location_id,),
        ).fetchone()
        if row is None:
            return Kept.SKIPPED
        lab_id, external_id, source_rev, sha256, mime = row[:5]
        source = SourceRow(row[5], row[6], SourceKind(row[7]), row[8], row[9], row[10])
        with lab_lock(conn, lab_id, exclusive=False):
            try:
                data = read_file(source, rt.settings, rt.previews, external_id, source_rev)
            except SourceReadError as e:
                log.info("original of %s not kept: %s", location_id, e)
                return Kept.SKIPPED
            if hashlib.sha256(data).hexdigest() != sha256:
                return Kept.CHANGED
            keep(conn, rt.previews, lab_id, sha256, data, mime, source.kind)
            return Kept.KEPT
