"""Transcribing the videos labs link to their protocol pages, so a video is found by what's
said in it. Only a linked video is transcribed, as only a talk-through is: a lab's archive of
videos in Dropbox is indexed by name, and nobody pays to transcribe it by accident."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID

import psycopg

from bl_worker import process
from bl_worker.db import lab_lock
from bl_worker.domain import ExtractionKind, FileKind, SourceKind, SourceReadError, SourceRow
from bl_worker.extract import Extracted, ExtractionFailed, clean_text
from bl_worker.runtime import Runtime
from bl_worker.scan import LIVE_SOURCE
from bl_worker.sources import read_file
from bl_worker.transcribe import Transcriber, TranscriptionFailed
from bl_worker.video import AUDIO_MIME, Ffmpeg, NeedsFfmpeg, NoSound, audio_track

log = logging.getLogger(__name__)

# Mirrors video_max_bytes() in db/migrations/0010_videos.sql; a test checks they agree. A
# Dropbox video over it is linked and plays, but isn't read whole into this worker.
VIDEO_MAX_BYTES = 500 * 1024 * 1024


class Transcript(StrEnum):
    """Mirrors video_transcript in db/migrations/0010_videos.sql."""

    WAITING = "waiting"
    READY = "ready"
    FAILED = "failed"
    UNAVAILABLE = "unavailable"


class VideoTranscriptExtractor:
    """A video's sound, through the configured transcriber. Named after the transcriber, so a
    video is heard once per transcriber however many labs or pages link it."""

    def __init__(self, transcriber: Transcriber, ffmpeg: Ffmpeg) -> None:
        self.transcriber = transcriber
        self.ffmpeg = ffmpeg
        self.name = transcriber.name
        self.version = transcriber.version

    def extract(self, data: bytes) -> Extracted:
        t = self.transcriber.transcribe(audio_track(self.ffmpeg, data), AUDIO_MIME)
        return Extracted(
            ExtractionKind.TRANSCRIPT,
            clean_text(t.text.strip()),
            {"duration_s": t.duration_s, "language": t.language, "cost_usd": str(t.cost_usd)},
        )


# Every video a lab has on a page gets a row; a video linked from Dropbox through the file
# picker is found here, an uploaded one too once the worker has linked it.
DISCOVER = """
insert into videos (lab_id, sha256)
select distinct pf.lab_id, pf.sha256 from protocol_files pf
join blobs b on b.sha256 = pf.sha256 and b.file_kind = 'video'
on conflict do nothing
"""

# Waiting, still on a page, in a lab that isn't being deleted, and done indexing: an upload is
# linked before its poster is made, and its transcript waits until that's finished.
WAITING = """
select v.lab_id, v.sha256 from videos v join labs l on l.id = v.lab_id
where v.transcript = 'waiting' and l.deletion_requested_at is null
  and exists (select 1 from protocol_files pf where pf.lab_id = v.lab_id and pf.sha256 = v.sha256)
  and exists (
    select 1 from file_locations fl where fl.lab_id = v.lab_id and fl.sha256 = v.sha256
      and fl.index_state = 'indexed' and fl.deleted_at is null
  )
  and (%(lab)s::uuid is null or v.lab_id = %(lab)s)
  and (%(sha)s::text is null or v.sha256 = %(sha)s)
order by v.updated_at
limit 100
"""


def waiting(conn: psycopg.Connection) -> list[tuple[UUID, str]]:
    conn.execute(DISCOVER)
    return [(r[0], r[1]) for r in conn.execute(WAITING, {"lab": None, "sha": None})]


@dataclass(frozen=True)
class Readable:
    """A live place this lab's copy of the video can be read from."""

    external_id: str
    source_rev: str
    source: SourceRow


def _readable(conn: psycopg.Connection, lab_id: UUID, sha256: str) -> Readable | None:
    row = conn.execute(
        f"""
        select fl.external_id, fl.source_rev,
          s.id, s.lab_id, s.kind, s.root_path, s.token_ciphertext, s.cursor
        from file_locations fl join sources s on s.id = fl.source_id
        where fl.lab_id = %s and fl.sha256 = %s and fl.deleted_at is null
          and fl.index_state = 'indexed' and {LIVE_SOURCE}
        order by s.kind = 'upload' desc, fl.id
        limit 1
        """,
        (lab_id, sha256),
    ).fetchone()
    if row is None:
        return None
    source = SourceRow(row[2], row[3], SourceKind(row[4]), row[5], row[6], row[7])
    return Readable(row[0], row[1], source)


def _finish(
    conn: psycopg.Connection, lab_id: UUID, sha256: str, state: Transcript, error: str | None = None
) -> Transcript:
    conn.execute(
        "update videos set transcript = %s, transcript_error = %s, updated_at = now()"
        " where lab_id = %s and sha256 = %s and transcript = 'waiting'",
        (state, error[:500] if error else None, lab_id, sha256),
    )
    return state


def transcribe_video(rt: Runtime, lab_id: UUID, sha256: str) -> Transcript | None:
    """Transcribes one lab's linked video and makes its transcript searchable in that lab.
    Safe to re-run: the transcript is cached by (sha256, transcriber), and only a waiting row
    changes. None when there's nothing to do."""
    with rt.pool.connection() as conn, lab_lock(conn, lab_id, exclusive=False):
        if conn.execute(WAITING, {"lab": lab_id, "sha": sha256}).fetchone() is None:
            return None
        found = conn.execute("select size, mime from blobs where sha256 = %s", (sha256,)).fetchone()
        assert found is not None
        size, mime = found
        blob = process.Blob(sha256, FileKind.VIDEO, mime)
        extractor = VideoTranscriptExtractor(rt.transcriber, rt.ffmpeg)
        cached = conn.execute(
            "select 1 from extractions where sha256 = %s and extractor = %s"
            " and extractor_version = %s",
            (sha256, extractor.name, extractor.version),
        ).fetchone()
        if cached is None:
            if size > VIDEO_MAX_BYTES:
                return _finish(
                    conn,
                    lab_id,
                    sha256,
                    Transcript.UNAVAILABLE,
                    "This video is too long for us to transcribe. It still plays.",
                )
            outcome = _hear(rt, conn, lab_id, blob, extractor)
            if outcome is not None:
                return outcome
        process.rechunk(conn, rt.embedder, lab_id, sha256, FileKind.VIDEO)
        return _finish(conn, lab_id, sha256, Transcript.READY)


def _hear(
    rt: Runtime,
    conn: psycopg.Connection,
    lab_id: UUID,
    blob: process.Blob,
    extractor: VideoTranscriptExtractor,
) -> Transcript | None:
    """Reads the video and transcribes it into the extraction cache. Returns the final state
    when that didn't work, None when it did."""
    where = _readable(conn, lab_id, blob.sha256)
    if where is None:
        return _finish(
            conn, lab_id, blob.sha256, Transcript.FAILED, "We couldn't find this video's file."
        )
    try:
        data = read_file(
            where.source, rt.settings, rt.previews, where.external_id, where.source_rev
        )
    except SourceReadError as e:
        return _finish(conn, lab_id, blob.sha256, Transcript.FAILED, str(e))
    # A video indexed before posters existed gets one now that its bytes are here anyway.
    process.write_preview(conn, rt.previews, rt.ffmpeg, lab_id, blob, data)
    try:
        process.extract_cached(conn, extractor, lab_id, blob, data)
    except TranscriptionFailed as e:
        log.info("transcribing %s failed: %s", blob.sha256[:12], e)
        return _finish(conn, lab_id, blob.sha256, Transcript.FAILED, str(e))
    except (NeedsFfmpeg, NoSound) as e:
        return _finish(conn, lab_id, blob.sha256, Transcript.UNAVAILABLE, str(e))
    except ExtractionFailed as e:
        log.info("reading the sound of %s failed: %s", blob.sha256[:12], e)
        return _finish(conn, lab_id, blob.sha256, Transcript.UNAVAILABLE, str(e))
    return None
