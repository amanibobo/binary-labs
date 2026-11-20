"""Deleting a lab once an admin asked for it (decisions.md, "deleting a lab and
disconnecting Dropbox"). The request already hid the lab, dropped its tokens and stopped
its scans; this removes what's left and stamps lab_deletions. Safe to re-run from any
point: previews go first by prefix, then the rows and the completion stamp commit together."""

from __future__ import annotations

import logging
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from bl_worker.db import lab_lock
from bl_worker.previews import lab_prefix
from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

# Every table holding a lab's rows, each with a lab_id column. Deleting the lab row cascades
# to all of them; tests/test_deletion.py checks this list against the catalog.
LAB_TABLES = (
    "members",
    "sources",
    "file_locations",
    "file_versions",
    "uploads",
    "chunks",
    "previews",
    "labels",
    "corrections",
    "label_rules",
    "notes",
    "note_pages",
    "run_repeats",
    "experiments",
    "people",
    "model_calls",
    "protocols",
    "protocol_versions",
    "protocol_files",
    "talk_throughs",
    "pending_protocol_files",
    "videos",
    "data_tables",
    "charts",
    "sample_layouts",
    "instruments",
    "calendar_entries",
    "calendar_series",
    "calendar_reminders",
    "calendar_feeds",
    "file_vectors",
    "file_neighbors",
    "map_views",
    "check_requests",
    "check_results",
    "flags",
    "questions",
    "answer_feedback",
    "suggestions",
    "suggestion_labels",
    "audit_log",
    "runs",
    "run_files",
    "run_log",
    "run_debriefs",
    "run_debrief_answers",
    "run_suggestion_dismissals",
    "export_exclusions",
    "run_rubrics",
    "run_reviews",
    "task_exports",
    "task_model_runs",
)

# Tables that point at a blob by sha256 (besides extractions, which go with it). A blob none
# of them references after the lab's rows are gone was only this lab's.
BLOB_REFERENCES = (
    "file_locations",
    "file_versions",
    "chunks",
    "previews",
    "labels",
    "model_calls",
    "protocol_files",
    "videos",
    "data_tables",
    "charts",
    "sample_layouts",
    "file_vectors",
    "suggestion_labels",
    "talk_throughs",
    "note_pages",
    "run_files",
)
# The column a table names its blob by, where it isn't sha256: a talk-through drafted from a
# video names the video (its recording is a file_locations row).
BLOB_COLUMNS = {"talk_throughs": "video_sha256"}


def _blob_column(table: str) -> str:
    return BLOB_COLUMNS.get(table, "sha256")


LAB_CONTENT = " union ".join(
    f"select {_blob_column(t)} from {t} where lab_id = %(lab)s and {_blob_column(t)} is not null"
    for t in BLOB_REFERENCES
)

ORPHANS = "select b.sha256 from blobs b where b.sha256 = any(%(shas)s) " + " ".join(
    f"and not exists (select 1 from {t} r where r.{_blob_column(t)} = b.sha256)"
    for t in BLOB_REFERENCES
)

# Jobs that name the lab or one of its sources or files. A job in progress is left alone;
# the delete_lab job itself is one.
LAB_JOBS = """
delete from procrastinate_jobs
where status <> 'doing' and (
  args ->> 'lab_id' = %(lab)s::text
  or args ->> 'source_id' = any(%(sources)s::text[])
  or args ->> 'location_id' = any(%(locations)s::text[])
)
"""


def pending_deletions(conn: psycopg.Connection) -> list[UUID]:
    rows = conn.execute(
        "select lab_id from lab_deletions where completed_at is null order by requested_at"
    )
    return [r[0] for r in rows]


def delete_lab(rt: Runtime, lab_id: UUID) -> dict[str, int] | None:
    """Returns what it deleted, or None when there's nothing to do."""
    with rt.pool.connection() as conn:
        row = conn.execute(
            "select completed_at from lab_deletions where lab_id = %s", (lab_id,)
        ).fetchone()
        if row is None or row[0] is not None:
            return None
        with lab_lock(conn, lab_id, exclusive=True):
            preview_files = rt.previews.delete_prefix(lab_prefix(lab_id))
            with conn.transaction():
                counts = _delete_rows(conn, lab_id) | {"preview_files": preview_files}
                conn.execute(
                    "update lab_deletions set completed_at = now(), counts = %s where lab_id = %s",
                    (Jsonb(counts), lab_id),
                )
    log.info("deleted lab %s: %s", lab_id, counts)
    return counts


def _delete_rows(conn: psycopg.Connection, lab_id: UUID) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in LAB_TABLES:
        (counts[table],) = conn.execute(
            f"select count(*) from {table} where lab_id = %s", (lab_id,)
        ).fetchone()  # type: ignore[misc]
    shas = [r[0] for r in conn.execute(LAB_CONTENT, {"lab": lab_id})]
    sources = [
        str(r[0]) for r in conn.execute("select id from sources where lab_id = %s", (lab_id,))
    ]
    locations = [
        str(r[0])
        for r in conn.execute("select id from file_locations where lab_id = %s", (lab_id,))
    ]
    counts["jobs"] = conn.execute(
        LAB_JOBS, {"lab": lab_id, "sources": sources, "locations": locations}
    ).rowcount
    conn.execute("delete from labs where id = %s", (lab_id,))
    orphans = [r[0] for r in conn.execute(ORPHANS, {"shas": shas})]
    counts["extractions"] = conn.execute(
        "delete from extractions where sha256 = any(%s)", (orphans,)
    ).rowcount
    counts["blobs"] = conn.execute("delete from blobs where sha256 = any(%s)", (orphans,)).rowcount
    return counts
