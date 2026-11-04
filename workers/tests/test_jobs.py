import itertools

import pytest
from procrastinate import PsycopgConnector
from procrastinate.exceptions import AlreadyEnqueued

from bl_worker import samples
from bl_worker.jobs import app, due_sources


@pytest.fixture
def job_app(database_url):
    with app.replace_connector(PsycopgConnector(conninfo=database_url)) as a, a.open():
        yield a


def run_until_idle(job_app, rt):
    job_app.run_worker(
        wait=False, install_signal_handlers=False, additional_context={"runtime": rt}
    )


def test_only_sources_with_a_newer_request_and_a_folder_are_due(conn, make_lab):
    _never, requested, started, no_folder = (make_lab(n) for n in "abcd")
    conn.execute(
        "update sources set scan_requested_at = now() where id = any(%s)",
        ([requested.source_id, started.source_id, no_folder.source_id],),
    )
    conn.execute(
        "update sources set scan_started_at = now() + interval '1 second' where id = %s",
        (started.source_id,),
    )
    conn.execute("update sources set root_path = null where id = %s", (no_folder.source_id,))
    assert due_sources(conn) == [requested.source_id]


def test_scheduler_scans_and_worker_indexes_everything(rt, conn, make_lab, job_app):
    lab = make_lab()
    lab.write("AB/P450/batch3/gel.jpg", samples.gel_jpeg(seed=3))
    lab.write("AB/P450/batch3/notes.pdf", samples.pdf(["SDS-PAGE of P450"]))
    lab.write("CD/plate.csv", samples.csv_text([["Well", "OD"], ["A1", 1]]))
    conn.execute("update sources set scan_requested_at = now() where id = %s", (lab.source_id,))

    job_app.configure_task("schedule_scans").defer(timestamp=0)
    run_until_idle(job_app, rt)

    states = conn.execute(
        "select index_state, count(*) from file_locations where lab_id = %s group by 1", (lab.id,)
    ).fetchall()
    assert states == [("indexed", 3)]
    assert due_sources(conn) == []
    jobs = dict(
        conn.execute(
            "select task_name || ':' || status, count(*) from procrastinate_jobs group by 1"
        ).fetchall()
    )
    # The worker's own periodic deferrer may add a scheduler run when the clock crosses a
    # 10-second mark; a second run must find nothing due and start no second scan.
    schedule_runs = jobs.pop("schedule_scans:succeeded")
    assert schedule_runs >= 1
    jobs.pop("tend_labels:succeeded", None)
    jobs.pop("sweep_deletions:succeeded", None)
    assert jobs == {
        "process_location:succeeded": 3,
        "scan_source:succeeded": 1,
        "label_blob:succeeded": 3,
    }
    labels = conn.execute(
        "select status, source from labels where lab_id = %s order by status", (lab.id,)
    ).fetchall()
    assert len(labels) == 3 and {source for _, source in labels} == {"rules"}


def test_a_queued_scan_is_not_queued_twice(conn, make_lab, job_app):
    lab = make_lab()
    deferrer = job_app.configure_task("scan_source", queueing_lock=str(lab.source_id))
    deferrer.defer(source_id=str(lab.source_id))
    with pytest.raises(AlreadyEnqueued):
        job_app.configure_task("scan_source", queueing_lock=str(lab.source_id)).defer(
            source_id=str(lab.source_id)
        )


def test_scheduler_fires_every_10_seconds():
    (periodic,) = [
        p for p in app.periodic_registry.periodic_tasks.values() if p.task.name == "schedule_scans"
    ]
    it = periodic.croniter
    it.set_current(start_time=1_800_000_003)  # an arbitrary instant, mid-minute
    fires = [round(it.get_next(ret_type=float)) for _ in range(8)]
    assert [b - a for a, b in itertools.pairwise(fires)] == [10] * 7
