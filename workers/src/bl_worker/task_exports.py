"""Removes the stored files of task folders whose sharing went off.

The web app builds a folder under <lab_id>/exports/<id>/ and records it in task_exports.
When a run's sharing or the lab's agreement goes off, a trigger sets withdrawn_at; this takes
the folder's files out of our store and then forgets where they were. A crash between the two
leaves the prefix on the row, so the next sweep deletes again and finishes."""

from __future__ import annotations

import logging

from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

BATCH = 200


def remove_withdrawn(rt: Runtime) -> int:
    """Returns how many withdrawn folders had their files removed."""
    removed = 0
    with rt.pool.connection() as conn:
        rows = conn.execute(
            "select id, lab_id, storage_prefix from task_exports"
            " where withdrawn_at is not null and storage_prefix is not null"
            " order by withdrawn_at limit %s",
            (BATCH,),
        ).fetchall()
        for export_id, lab_id, prefix in rows:
            # Only ever the folder's own place: a row that names anywhere else is left alone.
            if prefix != f"{lab_id}/exports/{export_id}":
                log.error("withdrawn folder %s has an unexpected prefix; left alone", export_id)
                continue
            files = rt.previews.delete_prefix(f"{prefix}/")
            conn.execute(
                "update task_exports set storage_prefix = null"
                " where id = %s and withdrawn_at is not null",
                (export_id,),
            )
            log.info("removed %d files of withdrawn folder %s", files, export_id)
            removed += 1
    return removed
