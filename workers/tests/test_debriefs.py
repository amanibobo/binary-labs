"""A run's debrief answers (0038): the worker transcribes each recording like a talk-through,
and no model labels it."""

import hashlib
from dataclasses import replace
from datetime import UTC, datetime

from conftest import as_user, committed_as_user, run_scan

from bl_worker.labels import job as labels
from bl_worker.models import FakeModels
from bl_worker.previews import file_key
from bl_worker.process import Outcome
from bl_worker.transcribe import FakeTranscriber

TODAY = datetime.now(UTC).date()
SAID = "I think the IPTG stock was old, so the cells never switched on."


def failed_run(rt, conn, lab):
    lab.write("plate.csv", "well,od\nA1,0.1\n")
    assert run_scan(rt, lab.source_id) == [Outcome.INDEXED]
    (sha,) = conn.execute(
        "select sha256 from file_locations where lab_id = %s", (lab.id,)
    ).fetchone()
    with committed_as_user(conn, lab.user_id):
        (run,) = conn.execute(
            "select (create_run(%s, %s, %s::jsonb)) ->> 'id'",
            (lab.id, [sha], '{"title": "BM3", "status": "failed"}'),
        ).fetchone()
        (debrief,) = conn.execute("select start_debrief(%s) ->> 'id'", (run,)).fetchone()
    return run, debrief


def answer(rt, conn, lab, debrief, question, data):
    """What the upload route does for a debrief answer: store the bytes, then record them."""
    sha = hashlib.sha256(data).hexdigest()
    rt.previews.put(file_key(lab.id, sha), data)
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "select record_debrief_answer(%s, %s::smallint, %s, %s, %s, %s, null)",
            (debrief, question, sha, len(data), f"Debrief answer {question}.weba", TODAY),
        )
    return sha


def upload_source(conn, lab_id):
    return conn.execute(
        "select id from sources where lab_id = %s and kind = 'upload'", (lab_id,)
    ).fetchone()[0]


def test_a_debrief_answer_is_transcribed_and_read_back_beside_its_recording(rt, conn, make_lab):
    heard = FakeTranscriber(lambda audio: SAID)
    rt = replace(rt, transcriber=heard)
    lab = make_lab()
    run, debrief = failed_run(rt, conn, lab)
    answer(rt, conn, lab, debrief, 3, b"\x1aE\xdf\xa3 audio " + b"q3" * 50)
    with as_user(conn, lab.user_id):
        (before,) = conn.execute(
            "select run_debrief(%s) -> 'answers' -> 0 -> 'recording'", (run,)
        ).fetchone()
    assert before["index_state"] == "pending" and before["transcript"] is None

    assert run_scan(rt, upload_source(conn, lab.id)) == [Outcome.INDEXED]
    assert len(heard.calls) == 1
    with as_user(conn, lab.user_id):
        (after,) = conn.execute(
            "select run_debrief(%s) -> 'answers' -> 0 -> 'recording'", (run,)
        ).fetchone()
    assert (after["index_state"], after["transcript"]) == ("indexed", SAID)


def test_a_debrief_recording_gets_no_label_from_a_model(rt, conn, make_lab):
    models = FakeModels(lambda request: "{}")
    rt = replace(rt, transcriber=FakeTranscriber(lambda audio: SAID), models=models)
    lab = make_lab()
    _, debrief = failed_run(rt, conn, lab)
    sha = answer(rt, conn, lab, debrief, 1, b"\x1aE\xdf\xa3 audio " + b"q1" * 50)
    run_scan(rt, upload_source(conn, lab.id))
    models.calls.clear()

    assert (lab.id, sha) not in labels.unlabeled(conn, models=True)
    assert labels.label_blob(rt, lab.id, sha) is None
    assert models.calls == []
    assert conn.execute("select count(*) from labels where sha256 = %s", (sha,)).fetchone() == (0,)
