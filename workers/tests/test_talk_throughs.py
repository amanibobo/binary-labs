import hashlib
import json
import uuid
from dataclasses import replace
from datetime import UTC, datetime

import httpx
import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan, search
from procrastinate import PsycopgConnector
from psycopg.rows import dict_row

from bl_worker import deletion, process
from bl_worker.domain import FileKind
from bl_worker.filekind import detect
from bl_worker.jobs import app
from bl_worker.models import TIER2_MODEL, FakeModels, ModelUnavailable
from bl_worker.previews import file_key, lab_prefix
from bl_worker.process import Outcome
from bl_worker.talk_throughs import (
    STEPS_PROMPT_VERSION,
    Draft,
    UnusableDraft,
    draft_steps,
    parse_steps,
    waiting_for_steps,
)
from bl_worker.transcribe import (
    SCRIBE_URL,
    ElevenLabsTranscriber,
    FakeTranscriber,
    TranscriptionFailed,
    Unconfigured,
)

TODAY = datetime.now(UTC).date()
SPOKEN = (
    "Okay so this is how I run the mini prep. Grab the overnight culture, the P1 buffer and "
    "the spin columns. Spin down 2 mL of culture at 8000 g for 2 minutes. Resuspend the pellet "
    "in 250 microliters of P1. Add 250 of P2 and invert, um, four to six times, and don't "
    "vortex it or you'll shear the DNA. Then add 350 of N3 and spin 10 minutes."
)
STEPS_JSON = json.dumps(
    {
        "title": "Mini prep",
        "materials": ["Overnight culture", "P1 buffer", "Spin columns"],
        "steps": [
            "Spin down 2 mL of culture at 8000 g for 2 minutes.",
            "1. Resuspend the pellet in 250 microliters of P1.",
            "Add 250 of P2 and invert four to six times.",
            "Add 350 of N3 and spin 10 minutes.",
        ],
        "cautions": ["Don't vortex after adding P2, or you'll shear the DNA."],
    }
)


def recording(seed: str = "mini prep") -> bytes:
    """Bytes standing in for a WebM recording; the fake transcriber never decodes them."""
    return b"\x1aE\xdf\xa3 audio " + seed.encode() * 50


def record(rt, conn, lab, data, *, user=None, protocol=None, base=None, kind="protocol"):
    """What the upload route does for a talk-through: store the bytes, then record them."""
    sha = hashlib.sha256(data).hexdigest()
    rt.previews.put(file_key(lab.id, sha), data)
    with committed_as_user(conn, user or lab.user_id):
        row = conn.execute(
            "select talk_through_id, location_id, duplicate"
            " from record_talk_through(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                lab.id,
                sha,
                len(data),
                "Talk-through 2026-11-04 14.03.22.weba",
                TODAY,
                None,
                kind,
                protocol,
                base,
                95_000,
            ),
        ).fetchone()
    return sha, row


def upload_source(conn, lab_id):
    return conn.execute(
        "select id from sources where lab_id = %s and kind = 'upload'", (lab_id,)
    ).fetchone()[0]


def view(conn, user_id, talk_through_id):
    with as_user(conn, user_id), conn.cursor(row_factory=dict_row) as cur:
        return cur.execute("select * from talk_through(%s)", (talk_through_id,)).fetchone()


def make_protocol(conn, lab, title="Mini prep", body="1. Spin."):
    with committed_as_user(conn, lab.user_id):
        return conn.execute(
            "select protocol_id, version_id from create_protocol(%s, 'protocol', %s, %s)",
            (lab.id, title, body),
        ).fetchone()


@pytest.fixture
def fake():
    return FakeTranscriber(lambda audio: SPOKEN)


@pytest.fixture
def models():
    return FakeModels(lambda request: STEPS_JSON)


@pytest.fixture
def tt_rt(rt, fake, models):
    return replace(rt, transcriber=fake, models=models)


def raises_code(code):
    return pytest.raises(psycopg.Error, check=lambda e: e.sqlstate == code)


def test_a_recording_becomes_a_searchable_transcript_and_a_draft_to_review(
    tt_rt, conn, make_lab, fake, models
):
    lab = make_lab()
    sha, (tt_id, location_id, duplicate) = record(tt_rt, conn, lab, recording())
    assert duplicate is False
    assert view(conn, lab.user_id, tt_id)["index_state"] == "pending"

    assert run_scan(tt_rt, upload_source(conn, lab.id)) == [Outcome.INDEXED]
    path, kind, mime = conn.execute(
        "select fl.path, b.file_kind, b.mime from file_locations fl join blobs b using (sha256)"
        " where fl.id = %s",
        (location_id,),
    ).fetchone()
    assert (path, kind, mime) == (
        "/Uploads/Talk-throughs/Talk-through 2026-11-04 14.03.22.weba",
        "audio",
        "audio/webm",
    )
    drafting = view(conn, lab.user_id, tt_id)
    assert (drafting["transcript"], drafting["draft"]) == (SPOKEN, "waiting")
    assert waiting_for_steps(conn) == [tt_id]

    assert draft_steps(tt_rt, tt_id) is Draft.READY
    ready = view(conn, lab.user_id, tt_id)
    assert ready["draft"] == "ready"
    assert ready["draft_title"] == "Mini prep"
    assert ready["draft_body"] == (
        "## Materials\n\n- Overnight culture\n- P1 buffer\n- Spin columns\n\n"
        "## Steps\n\n"
        "1. Spin down 2 mL of culture at 8000 g for 2 minutes.\n"
        "2. Resuspend the pellet in 250 microliters of P1.\n"
        "3. Add 250 of P2 and invert four to six times.\n"
        "4. Add 350 of N3 and spin 10 minutes.\n\n"
        "## Cautions\n\n- Don't vortex after adding P2, or you'll shear the DNA.\n"
    )
    assert ready["kind"] == "protocol" and ready["duration_ms"] == 95_000
    assert waiting_for_steps(conn) == []

    # The model saw only the transcript, marked as data.
    (request,) = models.calls
    assert request.model == TIER2_MODEL and request.effort == "medium"
    assert request.content == (f"<transcript>\n{SPOKEN}\n</transcript>",)

    ledger = conn.execute(
        "select purpose, model, prompt_version, cost_usd from model_calls"
        " where lab_id = %s and sha256 = %s order by purpose",
        (lab.id, sha),
    ).fetchall()
    assert [(p, m, v) for p, m, v, _ in ledger] == [
        ("transcript", "fake", 1),
        ("steps", TIER2_MODEL, STEPS_PROMPT_VERSION),
    ]
    assert str(ledger[0][3]) == "0.002500"

    with as_user(conn, lab.user_id):
        hits = search(conn, lab.id, "shear the DNA", None)
        assert [h["sha256"] for h in hits] == [sha]
    assert len(fake.calls) == 1


def test_the_same_audio_is_never_transcribed_or_drafted_twice(tt_rt, conn, make_lab, fake, models):
    a, b = make_lab("alpha"), make_lab("bravo")
    data = recording()
    _, (tt_a, loc_a, _) = record(tt_rt, conn, a, data)
    run_scan(tt_rt, upload_source(conn, a.id))
    draft_steps(tt_rt, tt_a)

    # The same bytes sent again in the same lab: one talk-through, already transcribed.
    _, (again, loc_again, duplicate) = record(tt_rt, conn, a, data)
    assert (again, loc_again, duplicate) == (tt_a, loc_a, True)
    conn.execute("update file_locations set index_state = 'pending' where id = %s", (loc_a,))
    assert process.process_location(tt_rt, loc_a) is Outcome.INDEXED
    assert draft_steps(tt_rt, tt_a) is None

    # Another lab recording the same audio reuses the transcript; its own draft is its own call.
    _, (tt_b, _, _) = record(tt_rt, conn, b, data)
    run_scan(tt_rt, upload_source(conn, b.id))
    assert view(conn, b.user_id, tt_b)["transcript"] == SPOKEN
    assert draft_steps(tt_rt, tt_b) is Draft.READY

    assert len(fake.calls) == 1
    assert len(models.calls) == 2
    assert conn.execute(
        "select count(*) from model_calls where purpose = 'transcript'"
    ).fetchone() == (1,)


def test_without_a_model_the_transcript_is_still_there_to_start_from(rt, conn, make_lab, fake):
    lab = make_lab()
    no_model = replace(rt, transcriber=fake, models=None)
    _, (tt_id, _, _) = record(no_model, conn, lab, recording())
    run_scan(no_model, upload_source(conn, lab.id))
    assert draft_steps(no_model, tt_id) is Draft.UNAVAILABLE
    row = view(conn, lab.user_id, tt_id)
    assert (row["draft"], row["transcript"]) == ("unavailable", SPOKEN)
    assert "Start from the transcript" in row["draft_error"]


@pytest.mark.parametrize(
    ("spoken", "answer", "outcome"),
    [
        ("", STEPS_JSON, Draft.UNAVAILABLE),
        (SPOKEN, None, Draft.UNAVAILABLE),
        (SPOKEN, '{"title": "x", "materials": [], "steps": [], "cautions": []}', Draft.UNAVAILABLE),
        (SPOKEN, '{"title": "x"}', Draft.UNAVAILABLE),
    ],
    ids=["silence", "refusal", "no steps", "malformed"],
)
def test_a_draft_that_cant_be_made_says_so(rt, conn, make_lab, spoken, answer, outcome):
    lab = make_lab()
    tt = replace(
        rt, transcriber=FakeTranscriber(lambda a: spoken), models=FakeModels(lambda r: answer)
    )
    _, (tt_id, _, _) = record(tt, conn, lab, recording())
    run_scan(tt, upload_source(conn, lab.id))
    assert draft_steps(tt, tt_id) is outcome
    row = view(conn, lab.user_id, tt_id)
    assert row["draft"] == outcome and row["draft_error"] and row["draft_body"] is None


def test_an_unreachable_model_fails_and_a_retry_drafts_again(rt, conn, make_lab, fake):
    lab = make_lab()
    replies = iter([ModelUnavailable("APIConnectionError"), STEPS_JSON])

    def answer(request):
        reply = next(replies)
        if isinstance(reply, Exception):
            raise reply
        return reply

    tt = replace(rt, transcriber=fake, models=FakeModels(answer))
    _, (tt_id, _, _) = record(tt, conn, lab, recording())
    run_scan(tt, upload_source(conn, lab.id))
    assert draft_steps(tt, tt_id) is Draft.FAILED
    assert view(conn, lab.user_id, tt_id)["draft_error"].endswith("Try again.")
    assert conn.execute("select count(*) from model_calls where purpose = 'steps'").fetchone() == (
        0,
    )

    with committed_as_user(conn, lab.user_id):
        conn.execute("select retry_talk_through(%s)", (tt_id,))
    assert waiting_for_steps(conn) == [tt_id]
    assert draft_steps(tt, tt_id) is Draft.READY


def test_a_failed_transcription_shows_why_and_a_retry_hears_it_again(rt, conn, make_lab, fake):
    lab = make_lab()
    broken = replace(rt, transcriber=Unconfigured("Speech-to-text isn't set up."))
    _, (tt_id, _, _) = record(broken, conn, lab, recording())
    assert run_scan(broken, upload_source(conn, lab.id)) == [Outcome.FAILED]
    row = view(conn, lab.user_id, tt_id)
    assert (row["index_state"], row["index_error"]) == ("failed", "Speech-to-text isn't set up.")
    assert waiting_for_steps(conn) == []

    with committed_as_user(conn, lab.user_id):
        conn.execute("select retry_talk_through(%s)", (tt_id,))
    assert view(conn, lab.user_id, tt_id)["index_state"] == "pending"
    fixed = replace(rt, transcriber=fake)
    assert run_scan(fixed, upload_source(conn, lab.id)) == [Outcome.INDEXED]
    assert view(conn, lab.user_id, tt_id)["transcript"] == SPOKEN


def test_audio_in_a_labs_own_folders_is_indexed_by_name_not_transcribed(
    tt_rt, conn, make_lab, fake
):
    lab = make_lab()
    lab.write("Recordings/group meeting.m4a", recording("meeting"))
    assert run_scan(tt_rt, lab.source_id) == [Outcome.INDEXED]
    assert conn.execute("select file_kind from blobs").fetchall() == [("audio",)]
    assert conn.execute("select count(*) from extractions").fetchone() == (0,)
    assert fake.calls == []


def test_using_the_steps_makes_a_new_page_with_the_audio_linked(tt_rt, conn, make_lab):
    lab = make_lab()
    sha, (tt_id, _, _) = record(tt_rt, conn, lab, recording(), kind="tutorial")
    run_scan(tt_rt, upload_source(conn, lab.id))
    draft_steps(tt_rt, tt_id)
    row = view(conn, lab.user_id, tt_id)

    with committed_as_user(conn, lab.user_id):
        protocol_id, _, version = conn.execute(
            "select * from use_talk_through(%s, 'tutorial', null, %s, %s)",
            (tt_id, row["draft_title"], row["draft_body"]),
        ).fetchone()
    assert version == 1
    kind, title, body, linked = conn.execute(
        "select p.kind, v.title, v.body, array(select f.sha256 from protocol_files f"
        " where f.protocol_id = p.id) from protocols p"
        " join protocol_versions v on v.id = p.current_version_id where p.id = %s",
        (protocol_id,),
    ).fetchone()
    assert (kind, title, body, linked) == ("tutorial", "Mini prep", row["draft_body"], [sha])
    used = view(conn, lab.user_id, tt_id)
    assert (used["used_protocol_id"], used["used_version"]) == (protocol_id, 1)

    with as_user(conn, lab.user_id), raises_code("BL105"):
        conn.execute("select * from use_talk_through(%s, 'tutorial', null, 't', 'b')", (tt_id,))


def test_using_the_steps_on_a_page_saves_on_top_of_the_version_recorded_against(
    tt_rt, conn, make_lab
):
    lab = make_lab()
    protocol_id, v1 = make_protocol(conn, lab)
    sha, (tt_id, _, _) = record(tt_rt, conn, lab, recording(), protocol=protocol_id, base=v1)
    run_scan(tt_rt, upload_source(conn, lab.id))
    draft_steps(tt_rt, tt_id)
    row = view(conn, lab.user_id, tt_id)
    assert (row["protocol_id"], row["base_version"], row["protocol_title"]) == (
        protocol_id,
        1,
        "Mini prep",
    )
    with as_user(conn, lab.user_id):
        listed = conn.execute(
            "select id, draft from open_talk_throughs(%s, %s)", (lab.id, protocol_id)
        ).fetchall()
        assert listed == [(tt_id, "ready")]
        assert conn.execute("select id from open_talk_throughs(%s)", (lab.id,)).fetchall() == []

    # Someone saves while the draft waits: using it on the old base is refused, not overwritten.
    with committed_as_user(conn, lab.user_id):
        (v2,) = conn.execute(
            "select version_id from save_protocol(%s, %s, 'Mini prep', '1. Spin longer.')",
            (protocol_id, v1),
        ).fetchone()
    with as_user(conn, lab.user_id), raises_code("BL101"):
        conn.execute(
            "select * from use_talk_through(%s, 'protocol', %s, 'Mini prep', %s)",
            (tt_id, v1, row["draft_body"]),
        )
    with committed_as_user(conn, lab.user_id):
        _, _, version = conn.execute(
            "select * from use_talk_through(%s, 'protocol', %s, 'Mini prep', %s,"
            " 'From a talk-through')",
            (tt_id, v2, row["draft_body"]),
        ).fetchone()
    assert version == 3
    note, linked = conn.execute(
        "select v.note, array(select f.sha256 from protocol_files f where f.protocol_id = p.id)"
        " from protocols p join protocol_versions v on v.id = p.current_version_id"
        " where p.id = %s",
        (protocol_id,),
    ).fetchone()
    assert (note, linked) == ("From a talk-through", [sha])
    with as_user(conn, lab.user_id):
        assert (
            conn.execute(
                "select id from open_talk_throughs(%s, %s)", (lab.id, protocol_id)
            ).fetchall()
            == []
        )


def test_one_labs_talk_throughs_are_invisible_to_another(tt_rt, conn, make_lab):
    a, b = make_lab("alpha"), make_lab("bravo")
    protocol_a, v1 = make_protocol(conn, a)
    _, (tt_a, loc_a, _) = record(tt_rt, conn, a, recording(), protocol=protocol_a, base=v1)
    run_scan(tt_rt, upload_source(conn, a.id))
    draft_steps(tt_rt, tt_a)
    assert view(conn, a.user_id, tt_a)["transcript"] == SPOKEN

    assert view(conn, b.user_id, tt_a) is None
    with as_user(conn, b.user_id):
        assert conn.execute("select count(*) from talk_throughs").fetchone() == (0,)
        assert (
            conn.execute("select * from open_talk_throughs(%s, %s)", (a.id, protocol_a)).fetchall()
            == []
        )
        assert conn.execute("select 1 from file_locations where id = %s", (loc_a,)).fetchall() == []
        assert search(conn, a.id, "shear the DNA", None) == []
    # Transcripts are extractions, which no member reads directly in any lab.
    with as_user(conn, a.user_id), pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("select content from extractions")
    for sql, params, code in [
        ("select retry_talk_through(%s)", (tt_a,), "BL103"),
        ("select * from use_talk_through(%s, 'protocol', %s, 't', 'b')", (tt_a, v1), "BL103"),
        ("select mark_talk_through_used(%s, %s)", (tt_a, v1), "BL105"),
    ]:
        with as_user(conn, b.user_id), raises_code(code):
            conn.execute(sql, params)
    # Recording into another lab, or against its page, is refused before anything is stored.
    data = recording("bravo")
    sha = hashlib.sha256(data).hexdigest()
    for lab_id, protocol, base, code in [
        (a.id, None, None, "42501"),
        (b.id, protocol_a, v1, "BL103"),
    ]:
        with as_user(conn, b.user_id), raises_code(code):
            conn.execute(
                "select * from record_talk_through(%s, %s, 10, 'x.weba', %s, null, 'protocol',"
                " %s, %s, null)",
                (lab_id, sha, TODAY, protocol, base),
            )
    assert view(conn, a.user_id, tt_a)["used_version"] is None


def test_a_recording_over_the_audio_cap_is_refused(tt_rt, conn, make_lab):
    lab = make_lab()
    with as_user(conn, lab.user_id), raises_code("BL201"):
        conn.execute(
            "select * from record_talk_through(%s, %s, %s, 'x.weba', %s, null, 'protocol',"
            " null, null, null)",
            (lab.id, "a" * 64, 100 * 1024 * 1024 + 1, TODAY),
        )
    with as_user(conn, lab.user_id), raises_code("BL201"):
        conn.execute(
            "select * from record_upload(%s, %s, %s, 'x.jpg', null, %s, null)",
            (lab.id, "a" * 64, 50 * 1024 * 1024 + 1, TODAY),
        )


def test_deleting_the_lab_takes_its_audio_transcript_and_drafts(tt_rt, conn, make_lab):
    a, b = make_lab("alpha"), make_lab("bravo")
    sha, (tt_a, _, _) = record(tt_rt, conn, a, recording())
    run_scan(tt_rt, upload_source(conn, a.id))
    draft_steps(tt_rt, tt_a)
    _, (tt_b, _, _) = record(tt_rt, conn, b, recording("bravo only"))
    run_scan(tt_rt, upload_source(conn, b.id))
    assert (tt_rt.settings.preview_dir / file_key(a.id, sha)).is_file()

    with committed_as_user(conn, a.user_id):
        conn.execute("select request_lab_deletion(%s, 'alpha')", (a.id,))
    assert view(conn, a.user_id, tt_a) is None
    counts = deletion.delete_lab(tt_rt, a.id)

    assert counts is not None and counts["talk_throughs"] == 1
    assert not (tt_rt.settings.preview_dir / lab_prefix(a.id)).exists()
    assert conn.execute(
        "select count(*) from talk_throughs where lab_id = %s", (a.id,)
    ).fetchone() == (0,)
    assert conn.execute(
        "select count(*) from extractions where sha256 = %s", (sha,)
    ).fetchone() == (0,)
    assert conn.execute("select count(*) from blobs where sha256 = %s", (sha,)).fetchone() == (0,)
    found = conn.execute(
        "select count(*) from talk_throughs where draft_body like '%%shear%%'"
    ).fetchone()
    assert found == (0,)
    assert view(conn, b.user_id, tt_b)["transcript"] == SPOKEN


def test_parse_steps_numbers_the_steps_itself_and_leaves_out_empty_sections():
    draft = parse_steps(
        json.dumps(
            {
                "title": "  Plate   pouring ",
                "materials": [" "],
                "steps": ["- Melt the agar.", "2) Pour 20 mL per plate.", ""],
                "cautions": [],
            }
        )
    )
    assert draft.title == "Plate pouring"
    assert draft.body == "## Steps\n\n1. Melt the agar.\n2. Pour 20 mL per plate.\n"
    with pytest.raises(UnusableDraft):
        parse_steps('{"title": "x", "materials": [], "steps": [" "], "cautions": []}')
    with pytest.raises(UnusableDraft):
        parse_steps('{"title": "x", "materials": [], "steps": ["a"], "cautions": [], "extra": 1}')


def scribe(handler):
    calls = []

    def recorded(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    client = httpx.Client(transport=httpx.MockTransport(recorded))
    return ElevenLabsTranscriber("sk-test", client=client, backoff=lambda attempt: 0), calls


def test_scribe_sends_the_audio_and_prices_the_minutes():
    transcriber, calls = scribe(
        lambda r: httpx.Response(
            200,
            json={
                "text": SPOKEN,
                "language_code": "eng",
                "language_probability": 0.99,
                "words": [],
                "audio_duration_secs": 1800.0,
            },
        )
    )
    t = transcriber.transcribe(b"opus bytes", "audio/webm")
    assert (t.text, t.language, t.duration_s, str(t.cost_usd)) == (
        SPOKEN,
        "eng",
        1800.0,
        "0.110000",
    )
    (request,) = calls
    assert str(request.url) == SCRIBE_URL and request.headers["xi-api-key"] == "sk-test"
    body = request.read()
    assert b'name="model_id"\r\n\r\nscribe_v2' in body
    assert b"Content-Type: audio/webm\r\n\r\nopus bytes" in body
    assert transcriber.name == "elevenlabs/scribe_v2"


def test_scribe_retries_a_server_error_but_not_a_bad_request():
    transcriber, calls = scribe(lambda r: httpx.Response(503, json={"detail": "busy"}))
    with pytest.raises(TranscriptionFailed, match="503: busy"):
        transcriber.transcribe(b"x", "audio/webm")
    assert len(calls) == 3

    transcriber, calls = scribe(
        lambda r: httpx.Response(422, json={"detail": [{"msg": "audio is too short"}]})
    )
    with pytest.raises(TranscriptionFailed, match="422: audio is too short"):
        transcriber.transcribe(b"x", "audio/webm")
    assert len(calls) == 1


@pytest.mark.parametrize(
    ("name", "kind", "mime"),
    [
        ("Talk-through.weba", FileKind.AUDIO, "audio/webm"),
        ("Talk-through.m4a", FileKind.AUDIO, "audio/mp4"),
        ("memo.mp3", FileKind.AUDIO, "audio/mpeg"),
        ("clip.webm", FileKind.OTHER, "video/webm"),
    ],
)
def test_audio_is_known_by_its_extension_when_the_container_says_video(name, kind, mime):
    assert detect(name, b"\x1aE\xdf\xa3" + b"\x00" * 64) == (kind, mime)


def test_a_talk_through_needs_a_page_and_its_version_together(conn, make_lab):
    lab = make_lab()
    for protocol, base in [(uuid.uuid4(), None), (None, uuid.uuid4())]:
        with as_user(conn, lab.user_id), raises_code("22023"):
            conn.execute(
                "select * from record_talk_through(%s, %s, 10, 'x.weba', %s, null, 'protocol',"
                " %s, %s, null)",
                (lab.id, "b" * 64, TODAY, protocol, base),
            )


def test_the_worker_takes_a_recording_to_a_draft_on_its_own(tt_rt, conn, make_lab, database_url):
    lab = make_lab()
    _, (tt_id, _, _) = record(tt_rt, conn, lab, recording())
    with app.replace_connector(PsycopgConnector(conninfo=database_url)) as a, a.open():
        a.configure_task("schedule_scans").defer(timestamp=0)
        a.run_worker(
            wait=False, install_signal_handlers=False, additional_context={"runtime": tt_rt}
        )
    row = view(conn, lab.user_id, tt_id)
    assert (row["index_state"], row["draft"], row["draft_title"]) == (
        "indexed",
        "ready",
        "Mini prep",
    )
    statuses = conn.execute(
        "select status from procrastinate_jobs where task_name = 'draft_steps'"
    ).fetchall()
    assert statuses == [("succeeded",)]
