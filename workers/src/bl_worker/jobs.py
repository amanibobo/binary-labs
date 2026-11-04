from __future__ import annotations

import asyncio
import logging
from uuid import UUID

import psycopg
from procrastinate import App, JobContext, PsycopgConnector, RetryStrategy
from procrastinate.exceptions import AlreadyEnqueued

from bl_worker import process, scan
from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

# The real connector is swapped in at startup with app.replace_connector, once settings exist.
app = App(connector=PsycopgConnector())

DUE_SOURCES = """
select id from sources
where root_path is not null and scan_requested_at > coalesce(scan_started_at, '-infinity')
order by scan_requested_at
"""


def _runtime(context: JobContext) -> Runtime:
    return context.additional_context["runtime"]


def due_sources(conn: psycopg.Connection) -> list[UUID]:
    return [r[0] for r in conn.execute(DUE_SOURCES)]


def _defer_locked(name: str, lock: str, **kwargs: str) -> bool:
    try:
        app.configure_task(name, queueing_lock=lock).defer(**kwargs)
    except AlreadyEnqueued:
        return False
    return True


@app.periodic(cron="*/10 * * * * *")
@app.task(name="schedule_scans", pass_context=True, queueing_lock="schedule_scans")
async def schedule_scans(context: JobContext, timestamp: int) -> None:
    rt = _runtime(context)

    def due() -> list[UUID]:
        with rt.pool.connection() as conn:
            return due_sources(conn)

    for source_id in await asyncio.to_thread(due):
        try:
            await app.configure_task("scan_source", queueing_lock=str(source_id)).defer_async(
                source_id=str(source_id)
            )
            log.info("deferred scan of source %s", source_id)
        except AlreadyEnqueued:
            pass
    # A worker that died mid-job leaves it "doing" forever; every job here converges on rerun.
    for job in await app.job_manager.get_stalled_jobs():
        log.warning("retrying stalled job %s (%s)", job.id, job.task_name)
        await app.job_manager.retry_job(job)


@app.task(name="scan_source", pass_context=True, retry=RetryStrategy(max_attempts=3, wait=10))
def scan_source(context: JobContext, source_id: str) -> None:
    rt = _runtime(context)
    with rt.pool.connection() as conn:
        pending = scan.scan_source(conn, rt.settings, UUID(source_id))
    deferred = sum(
        _defer_locked("process_location", str(loc), location_id=str(loc)) for loc in pending
    )
    log.info("scanned source %s: %d pending, %d deferred", source_id, len(pending), deferred)


@app.task(name="process_location", pass_context=True, retry=RetryStrategy(max_attempts=3, wait=5))
def process_location(context: JobContext, location_id: str) -> None:
    outcome = process.process_location(_runtime(context), UUID(location_id))
    log.info("location %s: %s", location_id, outcome)
