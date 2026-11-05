import hashlib
import shutil
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan, search
from psycopg.rows import dict_row

from bl_worker import deletion, process
from bl_worker.domain import FileKind
from bl_worker.filekind import detect
from bl_worker.previews import file_key, lab_prefix
from bl_worker.transcribe import FakeTranscriber, Unconfigured
from bl_worker.video import Ffmpeg, audio_track, poster
from bl_worker.videos import VIDEO_MAX_BYTES, Transcript, transcribe_video, waiting

FIXTURES = Path(__file__).parent / "fixtures"
CLIP = (FIXTURES / "clip.mp4").read_bytes()
SILENT = (FIXTURES / "silent.mp4").read_bytes()
TODAY = datetime.now(UTC).date()
SPOKEN = "Hold the pipette at forty five degrees and dispense against the wall of the tube."
HAS_FFMPEG = shutil.which("ffmpeg") is not None
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg isn't installed")


@pytest.fixture
def fake():
    return FakeTranscriber(lambda audio: SPOKEN)


@pytest.fixture
def v_rt(rt, fake):
    return replace(rt, transcriber=fake)


def raises_code(code):
    return pytest.raises(psycopg.Error, check=lambda e: e.sqlstate == code)


def make_protocol(conn, lab, title="Pipetting"):
    with committed_as_user(conn, lab.user_id):
        return conn.execute(
            "select protocol_id from create_protocol(%s, 'tutorial', %s, '1. Pipette.')",
            (lab.id, title),
        ).fetchone()[0]


def add_video(rt, conn, lab, protocol_id, data=CLIP, *, name="Pipetting.mp4", user=None):
    """What the video upload route does once the bytes are in the store and checked."""
    sha = hashlib.sha256(data).hexdigest()
    rt.previews.put(file_key(lab.id, sha), data)
    with committed_as_user(conn, user or lab.user_id):
        row = conn.execute(
            "select location_id, duplicate, linked from record_video(%s, %s, %s, %s, %s, null, %s)",
            (lab.id, sha, len(data), name, TODAY, protocol_id),
        ).fetchone()
    return sha, row


def upload_source(conn, lab_id):
    return conn.execute(
        "select id from sources where lab_id = %s and kind = 'upload'", (lab_id,)
    ).fetchone()[0]


def page_videos(conn, user_id, protocol_id):
    with as_user(conn, user_id), conn.cursor(row_factory=dict_row) as cur:
        return cur.execute("select * from protocol_videos(%s)", (protocol_id,)).fetchall()


def video_row(conn, lab_id, sha):
    return conn.execute(
        "select transcript, transcript_error from videos where lab_id = %s and sha256 = %s",
        (lab_id, sha),
    ).fetchone()


def transcribe_all(rt):
    with rt.pool.connection() as c:
        todo = waiting(c)
    return [transcribe_video(rt, lab_id, sha) for lab_id, sha in todo]


@needs_ffmpeg
def test_an_added_video_is_linked_once_verified_then_found_by_what_is_said(
    v_rt, conn, make_lab, fake
):
    lab = make_lab()
    page = make_protocol(conn, lab)
    sha, (location_id, duplicate, linked) = add_video(v_rt, conn, lab, page)
    assert (duplicate, linked) == (False, False)
    [preparing] = page_videos(conn, lab.user_id, page)
    assert (preparing["state"], preparing["location_id"], preparing["sha256"]) == (
        "preparing",
        location_id,
        None,
    )
    assert conn.execute(
        "select path from file_locations where id = %s", (location_id,)
    ).fetchone() == ("/Uploads/Videos/Pipetting.mp4",)

    assert run_scan(v_rt, upload_source(conn, lab.id)) == [process.Outcome.INDEXED]
    assert conn.execute(
        "select file_kind, mime from blobs where sha256 = %s", (sha,)
    ).fetchone() == ("video", "video/mp4")
    assert conn.execute(
        "select count(*) from pending_protocol_files where location_id = %s", (location_id,)
    ).fetchone() == (0,)
    # Linked as the person who added it.
    assert conn.execute(
        "select actor from audit_log where action = 'protocol.link_file' and target = %s",
        (f"{page} {sha}",),
    ).fetchone() == (lab.user_id,)
    [ready] = page_videos(conn, lab.user_id, page)
    assert ready["state"] == "ready" and ready["sha256"] == sha and ready["has_poster"]
    assert (ready["mime"], ready["source_kind"], ready["transcript"]) == (
        "video/mp4",
        "upload",
        "waiting",
    )
    # Indexed by name only: nothing heard yet.
    assert fake.calls == []

    assert transcribe_all(v_rt) == [Transcript.READY]
    assert len(fake.calls) == 1 and fake.calls[0][:2] == b"\xff\xf1"  # AAC, not the whole video
    [ready] = page_videos(conn, lab.user_id, page)
    assert (ready["transcript"], ready["transcript_text"]) == ("ready", SPOKEN)
    with as_user(conn, lab.user_id):
        hits = search(conn, lab.id, "dispense against the wall", None)
    assert [h["sha256"] for h in hits] == [sha]
    assert conn.execute(
        "select purpose, model, cost_usd from model_calls where lab_id = %s and sha256 = %s",
        (lab.id, sha),
    ).fetchone() == ("transcript", "fake", Decimal("0.0025"))


@needs_ffmpeg
def test_a_video_is_heard_once_however_many_labs_and_pages_link_it(v_rt, conn, make_lab, fake):
    a, b = make_lab("alpha"), make_lab("bravo")
    page_a1, page_a2 = make_protocol(conn, a), make_protocol(conn, a, "Again")
    page_b = make_protocol(conn, b)
    sha, _ = add_video(v_rt, conn, a, page_a1)
    run_scan(v_rt, upload_source(conn, a.id))
    # The same bytes for a second page in the same lab are already verified: linked at once.
    _, (_, duplicate, linked) = add_video(v_rt, conn, a, page_a2)
    assert (duplicate, linked) == (True, True)
    add_video(v_rt, conn, b, page_b)
    run_scan(v_rt, upload_source(conn, b.id))

    assert sorted(transcribe_all(v_rt)) == [Transcript.READY, Transcript.READY]
    assert len(fake.calls) == 1
    assert transcribe_all(v_rt) == []
    assert transcribe_video(v_rt, a.id, sha) is None
    assert len(fake.calls) == 1
    # The lab whose copy was heard pays; the other reuses the transcript for nothing.
    assert conn.execute(
        "select count(*) from model_calls where sha256 = %s and purpose = 'transcript'", (sha,)
    ).fetchone() == (1,)
    with as_user(conn, b.user_id):
        assert [h["sha256"] for h in search(conn, b.id, "pipette", None)] == [sha]


@needs_ffmpeg
def test_only_a_video_on_a_page_is_transcribed(v_rt, conn, make_lab, fake):
    lab = make_lab()
    lab.write("techniques/western transfer.mp4", CLIP)
    assert run_scan(v_rt, lab.source_id) == [process.Outcome.INDEXED]
    sha = hashlib.sha256(CLIP).hexdigest()
    assert transcribe_all(v_rt) == []
    assert fake.calls == []
    # A poster comes with indexing, as for any image or PDF.
    assert conn.execute(
        "select count(*) from previews where lab_id = %s and sha256 = %s", (lab.id, sha)
    ).fetchone() == (1,)

    # Linking it from the index, through the file picker, is what asks for a transcript.
    page = make_protocol(conn, lab)
    with committed_as_user(conn, lab.user_id):
        conn.execute("select link_protocol_file(%s, %s)", (page, sha))
    assert transcribe_all(v_rt) == [Transcript.READY]
    [video] = page_videos(conn, lab.user_id, page)
    assert (video["source_kind"], video["transcript_text"]) == ("local", SPOKEN)


def test_without_ffmpeg_a_video_plays_with_no_poster_and_says_why_there_is_no_transcript(
    v_rt, conn, make_lab, fake
):
    no_ffmpeg = replace(v_rt, ffmpeg=Ffmpeg.find("/nowhere/ffmpeg"))
    lab = make_lab()
    page = make_protocol(conn, lab)
    add_video(no_ffmpeg, conn, lab, page)
    assert run_scan(no_ffmpeg, upload_source(conn, lab.id)) == [process.Outcome.INDEXED]
    assert transcribe_all(no_ffmpeg) == [Transcript.UNAVAILABLE]
    assert fake.calls == []
    [video] = page_videos(conn, lab.user_id, page)
    assert (video["state"], video["has_poster"], video["transcript"]) == (
        "ready",
        False,
        "unavailable",
    )
    assert "ffmpeg" in video["transcript_error"]


@needs_ffmpeg
def test_a_video_linked_while_still_indexing_waits_for_its_transcript(v_rt, conn, make_lab, fake):
    lab = make_lab()
    page = make_protocol(conn, lab)
    sha, (location_id, _, _) = add_video(v_rt, conn, lab, page)
    run_scan(v_rt, upload_source(conn, lab.id))
    # As if the sweep ran after the link but before the poster and the indexed mark.
    conn.execute("update file_locations set index_state = 'pending' where id = %s", (location_id,))
    assert transcribe_all(v_rt) == []
    assert transcribe_video(v_rt, lab.id, sha) is None
    assert video_row(conn, lab.id, sha) == ("waiting", None)
    conn.execute("update file_locations set index_state = 'indexed' where id = %s", (location_id,))
    assert transcribe_all(v_rt) == [Transcript.READY]


@needs_ffmpeg
def test_a_silent_video_is_not_sent_to_the_transcriber(v_rt, conn, make_lab, fake):
    lab = make_lab()
    page = make_protocol(conn, lab)
    sha, _ = add_video(v_rt, conn, lab, page, SILENT, name="Silent.mp4")
    run_scan(v_rt, upload_source(conn, lab.id))
    assert transcribe_all(v_rt) == [Transcript.UNAVAILABLE]
    assert video_row(conn, lab.id, sha) == (
        "unavailable",
        "This video has no sound to transcribe.",
    )
    assert fake.calls == []


@needs_ffmpeg
def test_a_failed_transcription_waits_for_retry_and_then_works(v_rt, conn, make_lab, fake):
    lab = make_lab()
    page = make_protocol(conn, lab)
    sha, _ = add_video(v_rt, conn, lab, page)
    run_scan(v_rt, upload_source(conn, lab.id))
    broken = replace(v_rt, transcriber=Unconfigured("Speech-to-text isn't set up."))
    assert transcribe_all(broken) == [Transcript.FAILED]
    assert transcribe_all(v_rt) == []
    with committed_as_user(conn, lab.user_id):
        conn.execute("select retry_video_transcript(%s, %s)", (lab.id, sha))
    assert transcribe_all(v_rt) == [Transcript.READY]
    assert len(fake.calls) == 1


def test_a_video_over_the_cap_is_refused_and_the_caps_agree(v_rt, conn, make_lab):
    lab = make_lab()
    page = make_protocol(conn, lab)
    assert conn.execute("select video_max_bytes()").fetchone() == (VIDEO_MAX_BYTES,)
    with as_user(conn, lab.user_id), raises_code("BL201"):
        conn.execute(
            "select * from record_video(%s, %s, %s, 'big.mp4', %s, null, %s)",
            (lab.id, "a" * 64, VIDEO_MAX_BYTES + 1, TODAY, page),
        )


def test_a_dropbox_video_over_the_cap_plays_but_is_not_read_for_a_transcript(
    v_rt, conn, make_lab, fake
):
    lab = make_lab()
    lab.write("long.mp4", CLIP)
    run_scan(v_rt, lab.source_id)
    sha = hashlib.sha256(CLIP).hexdigest()
    conn.execute("update blobs set size = %s where sha256 = %s", (VIDEO_MAX_BYTES + 1, sha))
    page = make_protocol(conn, lab)
    with committed_as_user(conn, lab.user_id):
        conn.execute("select link_protocol_file(%s, %s)", (page, sha))
    assert transcribe_all(v_rt) == [Transcript.UNAVAILABLE]
    assert fake.calls == []
    assert "too long" in video_row(conn, lab.id, sha)[1]


def test_a_page_archived_before_the_bytes_were_read_keeps_the_upload_but_not_the_link(
    v_rt, conn, make_lab
):
    lab = make_lab()
    page = make_protocol(conn, lab)
    _, (location_id, _, _) = add_video(v_rt, conn, lab, page)
    with committed_as_user(conn, lab.user_id):
        conn.execute("select archive_protocol(%s)", (page,))
    assert run_scan(v_rt, upload_source(conn, lab.id)) == [process.Outcome.INDEXED]
    assert conn.execute(
        "select count(*) from protocol_files where protocol_id = %s", (page,)
    ).fetchone() == (0,)
    assert conn.execute(
        "select count(*) from pending_protocol_files where location_id = %s", (location_id,)
    ).fetchone() == (0,)


def test_bytes_that_do_not_match_their_hash_never_join_the_page(v_rt, conn, make_lab):
    lab = make_lab()
    page = make_protocol(conn, lab)
    with committed_as_user(conn, lab.user_id):
        (location_id,) = conn.execute(
            "select location_id from record_video(%s, %s, 10, 'claimed.mp4', %s, null, %s)",
            (lab.id, "b" * 64, TODAY, page),
        ).fetchone()
    assert run_scan(v_rt, upload_source(conn, lab.id)) == [process.Outcome.FAILED]
    [failed] = page_videos(conn, lab.user_id, page)
    assert (failed["state"], failed["location_id"]) == ("failed", location_id)
    assert "not in the object store" in failed["error"]
    # Someone in the lab can take it off the page.
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "delete from pending_protocol_files where protocol_id = %s and location_id = %s",
            (page, location_id),
        )
    assert page_videos(conn, lab.user_id, page) == []


@needs_ffmpeg
def test_one_lab_never_sees_or_adds_to_another_labs_videos(v_rt, conn, make_lab):
    a, b = make_lab("alpha"), make_lab("bravo")
    page_a = make_protocol(conn, a)
    page_b = make_protocol(conn, b)
    sha, _ = add_video(v_rt, conn, a, page_a)
    pending_location = add_video(v_rt, conn, a, page_a, SILENT, name="Second.mp4")[1][0]
    run_scan(v_rt, upload_source(conn, a.id))
    add_video(v_rt, conn, a, page_a, CLIP + b"tail", name="Third.mp4")
    transcribe_all(v_rt)

    assert page_videos(conn, b.user_id, page_a) == []
    with as_user(conn, b.user_id):
        assert conn.execute("select count(*) from videos").fetchone() == (0,)
        assert conn.execute("select count(*) from pending_protocol_files").fetchone() == (0,)
        conn.execute("delete from pending_protocol_files")
        conn.execute("select retry_video_transcript(%s, %s)", (b.id, sha))
    with as_user(conn, b.user_id), raises_code("42501"):
        conn.execute(
            "select * from record_video(%s, %s, 1, 'x.mp4', %s, null, %s)",
            (a.id, sha, TODAY, page_a),
        )
    # Bravo's own lab, alpha's page.
    with as_user(conn, b.user_id), raises_code("BL103"):
        conn.execute(
            "select * from record_video(%s, %s, 1, 'x.mp4', %s, null, %s)",
            (b.id, sha, TODAY, page_a),
        )
    with as_user(conn, b.user_id), raises_code("42501"):
        conn.execute("select retry_video_transcript(%s, %s)", (a.id, sha))
    assert pending_location is not None
    assert len(page_videos(conn, a.user_id, page_a)) == 3
    assert page_videos(conn, b.user_id, page_b) == []


@needs_ffmpeg
def test_deleting_the_lab_takes_its_videos_posters_transcripts_and_pending_links(
    v_rt, conn, make_lab
):
    a = make_lab("alpha")
    page = make_protocol(conn, a)
    sha, _ = add_video(v_rt, conn, a, page)
    run_scan(v_rt, upload_source(conn, a.id))
    transcribe_all(v_rt)
    add_video(v_rt, conn, a, page, SILENT, name="Not read yet.mp4")
    assert (v_rt.settings.preview_dir / file_key(a.id, sha)).is_file()

    with committed_as_user(conn, a.user_id):
        conn.execute("select request_lab_deletion(%s, 'alpha')", (a.id,))
    assert page_videos(conn, a.user_id, page) == []
    counts = deletion.delete_lab(v_rt, a.id)

    assert counts is not None and counts["videos"] == 1 and counts["pending_protocol_files"] == 1
    assert not (v_rt.settings.preview_dir / lab_prefix(a.id)).exists()
    for table in ("videos", "pending_protocol_files", "previews"):
        assert conn.execute(
            f"select count(*) from {table} where lab_id = %s", (a.id,)
        ).fetchone() == (0,)
    assert conn.execute(
        "select count(*) from extractions where sha256 = %s", (sha,)
    ).fetchone() == (0,)
    assert conn.execute("select count(*) from blobs where sha256 = %s", (sha,)).fetchone() == (0,)


@needs_ffmpeg
def test_ffmpeg_reads_a_poster_and_the_sound_and_says_when_there_is_none():
    ffmpeg = Ffmpeg.find("ffmpeg")
    frame = poster(ffmpeg, CLIP)
    assert frame is not None and (frame.width, frame.height) == (160, 120)
    assert frame.webp[:4] == b"RIFF"
    assert audio_track(ffmpeg, CLIP)[:2] == b"\xff\xf1"
    assert poster(ffmpeg, b"not a video") is None


def test_videos_are_known_by_their_bytes_and_by_their_extension():
    assert detect("clip.mp4", CLIP) == (FileKind.VIDEO, "video/mp4")
    assert detect("renamed.mp4", b"\x00\x00\x00\x14ftypqt  " + b"\x00" * 64) == (
        FileKind.VIDEO,
        "video/quicktime",
    )
    assert detect("IMG_0042.MOV", b"") == (FileKind.VIDEO, "video/quicktime")
