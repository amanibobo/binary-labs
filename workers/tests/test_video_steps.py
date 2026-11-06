"""Drafting steps from a video on a protocol's page (decisions.md, "steps from a video")."""

import json
from dataclasses import replace

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan
from psycopg.rows import dict_row
from test_videos import (
    CLIP,
    SILENT,
    SPOKEN,
    add_video,
    make_protocol,
    needs_ffmpeg,
    transcribe_all,
    upload_source,
)

from bl_worker.models import FakeModels
from bl_worker.talk_throughs import (
    STEPS_INSTRUCTIONS,
    VIDEO_STEPS_INSTRUCTIONS,
    Draft,
    draft_steps,
    waiting_for_steps,
)
from bl_worker.transcribe import FakeTranscriber

pytestmark = needs_ffmpeg

STEPS = json.dumps(
    {
        "title": "Pipetting against the wall",
        "materials": [],
        "steps": [
            "Hold the pipette at forty five degrees.",
            "Dispense against the wall of the tube.",
        ],
        "cautions": [],
    }
)


@pytest.fixture
def models():
    return FakeModels(lambda request: STEPS)


@pytest.fixture
def s_rt(rt, models):
    return replace(rt, transcriber=FakeTranscriber(lambda audio: SPOKEN), models=models)


def raises_code(code):
    return pytest.raises(psycopg.Error, check=lambda e: e.sqlstate == code)


def on_page(rt, conn, lab, data=CLIP):
    """A protocol with a verified video on it."""
    page = make_protocol(conn, lab)
    sha, _ = add_video(rt, conn, lab, page, data)
    run_scan(rt, upload_source(conn, lab.id))
    return page, sha


def start(conn, user_id, page, sha):
    with committed_as_user(conn, user_id):
        return conn.execute("select start_video_steps(%s, %s)", (page, sha)).fetchone()[0]


def view(conn, user_id, talk_through_id):
    with as_user(conn, user_id), conn.cursor(row_factory=dict_row) as cur:
        return cur.execute("select * from talk_through(%s)", (talk_through_id,)).fetchone()


def use(conn, user_id, talk_through_id, base, body):
    with committed_as_user(conn, user_id):
        return conn.execute(
            "select protocol_id, version from use_talk_through(%s, 'tutorial', %s, %s, %s)",
            (talk_through_id, base, "Pipetting", body),
        ).fetchone()


def test_steps_wait_for_the_videos_transcript_then_draft_with_the_same_model(
    s_rt, conn, make_lab, models
):
    lab = make_lab()
    page, sha = on_page(s_rt, conn, lab)
    tt = start(conn, lab.user_id, page, sha)
    # Asking again finds the same draft.
    assert start(conn, lab.user_id, page, sha) == tt

    row = view(conn, lab.user_id, tt)
    assert (row["source"], row["sha256"], row["index_state"], row["draft"]) == (
        "video",
        sha,
        "pending",
        "waiting",
    )
    assert row["name"] == "Pipetting.mp4" and row["current_version"] == 1
    assert row["current_body"] == "1. Pipette."
    # No transcript yet: nothing to draft from.
    assert waiting_for_steps(conn) == []
    assert draft_steps(s_rt, tt) is None
    assert models.calls == []

    transcribe_all(s_rt)
    assert waiting_for_steps(conn, video=(lab.id, sha)) == [tt]
    assert draft_steps(s_rt, tt) == Draft.READY
    [request] = models.calls
    assert request.system == (VIDEO_STEPS_INSTRUCTIONS,)
    assert VIDEO_STEPS_INSTRUCTIONS != STEPS_INSTRUCTIONS
    assert "filmed themselves" in VIDEO_STEPS_INSTRUCTIONS
    assert SPOKEN in request.content[0]
    row = view(conn, lab.user_id, tt)
    assert (row["index_state"], row["transcript"], row["draft"]) == ("indexed", SPOKEN, "ready")
    assert row["draft_body"].startswith("## Steps\n\n1. Hold the pipette")
    # Drafted once: running it again changes nothing and calls nobody.
    assert draft_steps(s_rt, tt) is None
    assert len(models.calls) == 1
    with as_user(conn, lab.user_id):
        [open_one] = conn.execute(
            "select id, index_state, draft from open_talk_throughs(%s, %s)", (lab.id, page)
        ).fetchall()
    assert open_one == (tt, "indexed", "ready")


def test_accepting_saves_a_new_version_on_top_of_the_one_it_was_drafted_against(
    s_rt, conn, make_lab
):
    lab = make_lab()
    page, sha = on_page(s_rt, conn, lab)
    tt = start(conn, lab.user_id, page, sha)
    transcribe_all(s_rt)
    draft_steps(s_rt, tt)
    row = view(conn, lab.user_id, tt)

    assert use(conn, lab.user_id, tt, row["base_version_id"], row["draft_body"]) == (page, 2)
    row = view(conn, lab.user_id, tt)
    assert (row["used_protocol_id"], row["used_version"], row["current_version"]) == (page, 2, 2)
    assert row["current_body"] == row["draft_body"]
    # The video was on the page already; it isn't linked twice.
    assert conn.execute(
        "select count(*) from protocol_files where protocol_id = %s", (page,)
    ).fetchone() == (1,)
    with raises_code("BL105"):
        use(conn, lab.user_id, tt, row["base_version_id"], "again")
    # A fresh ask starts a new draft against version 2.
    again = start(conn, lab.user_id, page, sha)
    assert again != tt and view(conn, lab.user_id, again)["base_version"] == 2


def test_an_edited_draft_is_saved_as_edited_and_a_stale_base_is_caught(s_rt, conn, make_lab):
    lab = make_lab()
    page, sha = on_page(s_rt, conn, lab)
    tt = start(conn, lab.user_id, page, sha)
    transcribe_all(s_rt)
    draft_steps(s_rt, tt)
    base = view(conn, lab.user_id, tt)["base_version_id"]
    # Someone saves the page while the draft waits.
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "select * from save_protocol(%s, %s, 'Pipetting', '1. Pipette slowly.')", (page, base)
        )
    with raises_code("BL101"):
        use(conn, lab.user_id, tt, base, "1. Edited.")
    current = conn.execute(
        "select current_version_id from protocols where id = %s", (page,)
    ).fetchone()[0]
    assert use(conn, lab.user_id, tt, current, "1. Edited.") == (page, 3)
    assert view(conn, lab.user_id, tt)["current_body"] == "1. Edited."


def test_a_dismissed_draft_is_put_aside_and_never_drafted(s_rt, conn, make_lab, models):
    lab = make_lab()
    page, sha = on_page(s_rt, conn, lab)
    tt = start(conn, lab.user_id, page, sha)
    with committed_as_user(conn, lab.user_id):
        conn.execute("select dismiss_talk_through(%s)", (tt,))
        conn.execute("select dismiss_talk_through(%s)", (tt,))
    assert view(conn, lab.user_id, tt)["dismissed_at"] is not None
    with as_user(conn, lab.user_id):
        assert (
            conn.execute("select * from open_talk_throughs(%s, %s)", (lab.id, page)).fetchall()
            == []
        )
    transcribe_all(s_rt)
    assert waiting_for_steps(conn) == []
    assert draft_steps(s_rt, tt) is None and models.calls == []
    with raises_code("BL105"):
        use(conn, lab.user_id, tt, view(conn, lab.user_id, tt)["base_version_id"], "x")
    assert start(conn, lab.user_id, page, sha) != tt


def test_a_silent_video_says_there_are_no_words_to_draft_from(s_rt, conn, make_lab, models):
    lab = make_lab()
    page, sha = on_page(s_rt, conn, lab, SILENT)
    tt = start(conn, lab.user_id, page, sha)
    transcribe_all(s_rt)
    assert draft_steps(s_rt, tt) == Draft.UNAVAILABLE
    row = view(conn, lab.user_id, tt)
    assert row["draft"] == "unavailable" and row["draft_error"] == row["index_error"]
    assert models.calls == []


def test_only_a_member_can_ask_and_only_for_a_video_on_the_page(s_rt, conn, make_lab):
    lab = make_lab()
    other = make_lab("other")
    page, sha = on_page(s_rt, conn, lab)
    with raises_code("BL103"):
        start(conn, other.user_id, page, sha)
    bare = make_protocol(conn, lab, "No video")
    with raises_code("BL104"):
        start(conn, lab.user_id, bare, sha)
    tt = start(conn, lab.user_id, page, sha)
    assert view(conn, other.user_id, tt) is None
    with raises_code("BL103"), committed_as_user(conn, other.user_id):
        conn.execute("select dismiss_talk_through(%s)", (tt,))
