from __future__ import annotations

import asyncio
import logging
from uuid import UUID

import psycopg
from procrastinate import App, JobContext, PsycopgConnector, RetryStrategy
from procrastinate.exceptions import AlreadyEnqueued

from bl_worker import data_tables, deletion, neighbors, process, scan, talk_throughs, videos
from bl_worker.labels import job as labels
from bl_worker.labels.learning import learn_pending
from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

# The real connector is swapped in at startup with app.replace_connector, once settings exist.
app = App(connector=PsycopgConnector())

DUE_SOURCES = f"""
select s.id from sources s
where {scan.LIVE_SOURCE} and s.scan_requested_at > coalesce(s.scan_started_at, '-infinity')
order by s.scan_requested_at
"""


def _runtime(context: JobContext) -> Runtime:
    return context.additional_context["runtime"]


def due_sources(conn: psycopg.Connection) -> list[UUID]:
    return [r[0] for r in conn.execute(DUE_SOURCES)]


# queueing_lock keeps one waiting job per key; lock keeps a second from running beside one
# already running, which would pay twice for a long transcription or model call.
def _defer_locked(name: str, lock: str, **kwargs: str) -> bool:
    try:
        app.configure_task(name, queueing_lock=lock, lock=lock).defer(**kwargs)
    except AlreadyEnqueued:
        return False
    return True


# croniter reads a sixth field as seconds, at the end.
@app.periodic(cron="* * * * * */10")
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
    rt = _runtime(context)
    outcome = process.process_location(rt, UUID(location_id))
    log.info("location %s: %s", location_id, outcome)
    with rt.pool.connection() as conn:
        row = conn.execute(
            "select lab_id, sha256 from file_locations where id = %s and sha256 is not null"
            " and index_state <> 'pending'",
            (UUID(location_id),),
        ).fetchone()
    if row is not None:
        defer_label(row[0], row[1])
        with rt.pool.connection() as conn:
            for talk_through_id in talk_throughs.waiting_for_steps(
                conn, location_id=UUID(location_id)
            ):
                defer_steps(row[0], talk_through_id)


def defer_label(lab_id: UUID, sha256: str) -> bool:
    return _defer_locked(
        "label_blob", f"label:{lab_id}:{sha256}", lab_id=str(lab_id), sha256=sha256
    )


@app.task(name="label_blob", pass_context=True, retry=RetryStrategy(max_attempts=3, wait=10))
def label_blob(context: JobContext, lab_id: str, sha256: str) -> None:
    draft = labels.label_blob(_runtime(context), UUID(lab_id), sha256)
    log.info("label %s: %s", sha256[:12], draft.status if draft else "skipped")


@app.periodic(cron="* * * * * */10")
@app.task(name="tend_labels", pass_context=True, queueing_lock="tend_labels")
async def tend_labels(context: JobContext, timestamp: int) -> None:
    """Learns from settled corrections, then queues labels for blobs that have none
    (files indexed before labels existed, or jobs that were lost)."""
    rt = _runtime(context)

    def tend() -> int:
        learn_pending(rt)
        with rt.pool.connection() as conn:
            todo = labels.unlabeled(conn, models=rt.models is not None)
        return sum(defer_label(lab_id, sha) for lab_id, sha in todo)

    deferred = await asyncio.to_thread(tend)
    if deferred:
        log.info("deferred %d label jobs", deferred)


# lab_id rides along so a lab's deletion clears its queued jobs (deletion.LAB_JOBS).
def defer_steps(lab_id: UUID, talk_through_id: UUID) -> bool:
    return _defer_locked(
        "draft_steps",
        f"steps:{talk_through_id}",
        lab_id=str(lab_id),
        talk_through_id=str(talk_through_id),
    )


@app.task(name="draft_steps", pass_context=True, retry=RetryStrategy(max_attempts=3, wait=10))
def draft_steps(context: JobContext, lab_id: str, talk_through_id: str) -> None:
    outcome = talk_throughs.draft_steps(_runtime(context), UUID(talk_through_id))
    log.info("steps for talk-through %s: %s", talk_through_id, outcome or "skipped")


@app.periodic(cron="* * * * * */10")
@app.task(name="tend_talk_throughs", pass_context=True, queueing_lock="tend_talk_throughs")
async def tend_talk_throughs(context: JobContext, timestamp: int) -> None:
    """Queues steps for transcribed talk-throughs that have none, so a retry or a lost job
    is picked up again."""
    rt = _runtime(context)

    def tend() -> int:
        with rt.pool.connection() as conn:
            todo = conn.execute(
                "select t.lab_id, t.id from talk_throughs t where t.id = any(%s)",
                (talk_throughs.waiting_for_steps(conn),),
            ).fetchall()
        return sum(defer_steps(lab_id, talk_through_id) for lab_id, talk_through_id in todo)

    deferred = await asyncio.to_thread(tend)
    if deferred:
        log.info("deferred %d talk-through drafts", deferred)


# Locked per video, not per lab: two labs linking the same video share one transcript, and the
# second waits for the first instead of paying for it again.
def defer_transcript(lab_id: UUID, sha256: str) -> bool:
    return _defer_locked("transcribe_video", f"video:{sha256}", lab_id=str(lab_id), sha256=sha256)


@app.task(name="transcribe_video", pass_context=True, retry=RetryStrategy(max_attempts=3, wait=10))
def transcribe_video(context: JobContext, lab_id: str, sha256: str) -> None:
    outcome = videos.transcribe_video(_runtime(context), UUID(lab_id), sha256)
    log.info("transcript of video %s: %s", sha256[:12], outcome or "skipped")


@app.periodic(cron="* * * * * */10")
@app.task(name="tend_videos", pass_context=True, queueing_lock="tend_videos")
async def tend_videos(context: JobContext, timestamp: int) -> None:
    """Queues transcripts for videos on a page that have none: one just linked, a retry, or a
    lost job."""
    rt = _runtime(context)

    def tend() -> int:
        with rt.pool.connection() as conn:
            todo = videos.waiting(conn)
        return sum(defer_transcript(lab_id, sha) for lab_id, sha in todo)

    deferred = await asyncio.to_thread(tend)
    if deferred:
        log.info("deferred %d video transcripts", deferred)


def defer_table(lab_id: UUID, sha256: str) -> bool:
    return _defer_locked(
        "parse_table", f"table:{lab_id}:{sha256}", lab_id=str(lab_id), sha256=sha256
    )


@app.task(name="parse_table", pass_context=True, retry=RetryStrategy(max_attempts=3, wait=10))
def parse_table(context: JobContext, lab_id: str, sha256: str) -> None:
    outcome = data_tables.parse_waiting(_runtime(context), UUID(lab_id), sha256)
    log.info("table of %s: %s", sha256[:12], outcome or "skipped")


@app.periodic(cron="* * * * * */10")
@app.task(name="tend_tables", pass_context=True, queueing_lock="tend_tables")
async def tend_tables(context: JobContext, timestamp: int) -> None:
    """Queues the tables someone asked for in the chart builder: a file indexed before charts
    existed, or one whose table failed and was asked for again."""
    rt = _runtime(context)

    def tend() -> int:
        with rt.pool.connection() as conn:
            todo = data_tables.waiting(conn)
        return sum(defer_table(lab_id, sha) for lab_id, sha in todo)

    deferred = await asyncio.to_thread(tend)
    if deferred:
        log.info("deferred %d tables", deferred)


# One job per lab at a time: two would redo the same lists side by side.
def defer_neighbors(lab_id: UUID) -> bool:
    return _defer_locked("refresh_neighbors", f"neighbors:{lab_id}", lab_id=str(lab_id))


@app.task(name="refresh_neighbors", pass_context=True, retry=RetryStrategy(max_attempts=3, wait=10))
def refresh_neighbors(context: JobContext, lab_id: str) -> None:
    neighbors.refresh_lab(_runtime(context), UUID(lab_id))


@app.periodic(cron="* * * * * */10")
@app.task(name="tend_neighbors", pass_context=True, queueing_lock="tend_neighbors")
async def tend_neighbors(context: JobContext, timestamp: int) -> None:
    """Queues a neighbor refresh for every lab with a file whose chunks changed, for the lab
    map's "Similar in meaning"."""
    rt = _runtime(context)

    def tend() -> int:
        with rt.pool.connection() as conn:
            labs = neighbors.stale_labs(conn)
        return sum(defer_neighbors(lab_id) for lab_id in labs)

    deferred = await asyncio.to_thread(tend)
    if deferred:
        log.info("deferred %d neighbor refreshes", deferred)


@app.task(name="delete_lab", pass_context=True, retry=RetryStrategy(max_attempts=3, wait=30))
def delete_lab(context: JobContext, lab_id: str) -> None:
    deletion.delete_lab(_runtime(context), UUID(lab_id))


@app.periodic(cron="* * * * * */10")
@app.task(name="sweep_deletions", pass_context=True, queueing_lock="sweep_deletions")
async def sweep_deletions(context: JobContext, timestamp: int) -> None:
    """Queues delete_lab for every lab marked for deletion and not finished, so a deletion
    that crashed or never got queued is picked up again."""
    rt = _runtime(context)

    def sweep() -> int:
        with rt.pool.connection() as conn:
            pending = deletion.pending_deletions(conn)
        return sum(
            _defer_locked("delete_lab", f"delete_lab:{lab_id}", lab_id=str(lab_id))
            for lab_id in pending
        )

    deferred = await asyncio.to_thread(sweep)
    if deferred:
        log.info("deferred %d lab deletions", deferred)
