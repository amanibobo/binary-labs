from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from bl_worker import data_tables, originals
from bl_worker.chunking import name_chunk, text_chunks
from bl_worker.db import lab_lock
from bl_worker.domain import ExtractionKind, FileKind, SourceKind, SourceReadError, SourceRow
from bl_worker.embed import Embedder
from bl_worker.extract import EXTRACTORS, Extracted, ExtractionFailed, Extractor, run_extractor
from bl_worker.filekind import detect
from bl_worker.previews import PreviewFailed, PreviewStore, preview_key, render_preview
from bl_worker.runtime import Runtime
from bl_worker.scan import LIVE_SOURCE
from bl_worker.sources import read_file
from bl_worker.transcribe import TranscriptExtractor
from bl_worker.video import Ffmpeg, poster

log = logging.getLogger(__name__)

# Errors that belong to the file, not to the system: the location fails and waits for the
# next rescan. Anything else propagates so the job itself fails and can be retried.
FILE_ERRORS = (SourceReadError, ExtractionFailed, PreviewFailed)


class Outcome(StrEnum):
    INDEXED = "indexed"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass(frozen=True)
class Location:
    id: UUID
    lab_id: UUID
    external_id: str
    original_name: str
    source_rev: str
    source: SourceRow


@dataclass(frozen=True)
class Blob:
    sha256: str
    kind: FileKind
    mime: str


def load_pending(conn: psycopg.Connection, location_id: UUID) -> Location | None:
    row = conn.execute(
        f"""
        select fl.id, fl.lab_id, fl.external_id, fl.original_name, fl.source_rev,
          s.id, s.lab_id, s.kind, s.root_path, s.token_ciphertext, s.cursor
        from file_locations fl join sources s on s.id = fl.source_id
        where fl.id = %s and fl.index_state = 'pending' and fl.deleted_at is null
          and {LIVE_SOURCE}
        """,
        (location_id,),
    ).fetchone()
    if row is None:
        return None
    source = SourceRow(row[5], row[6], SourceKind(row[7]), row[8], row[9], row[10])
    return Location(row[0], row[1], row[2], row[3], row[4], source)


def process_location(rt: Runtime, location_id: UUID) -> Outcome:
    """design.md "Processing one location". Safe to re-run from any point."""
    with rt.pool.connection() as conn:
        found = conn.execute(
            "select lab_id from file_locations where id = %s", (location_id,)
        ).fetchone()
        if found is None:
            return Outcome.SKIPPED
        with lab_lock(conn, found[0], exclusive=False):
            loc = load_pending(conn, location_id)
            if loc is None:
                return Outcome.SKIPPED
            return _process(rt, conn, loc)


def _process(rt: Runtime, conn: psycopg.Connection, loc: Location) -> Outcome:
    try:
        data = read_file(loc.source, rt.settings, rt.previews, loc.external_id, loc.source_rev)
        blob = _store_blob(conn, loc, data)
        originals.keep(conn, rt.previews, loc.lab_id, blob.sha256, data, blob.mime, loc.source.kind)
        link_pending(conn, loc.id, blob.sha256)
        extracted = extract_cached(conn, extractor_for(rt, conn, loc, blob), loc.lab_id, blob, data)
        _write_chunks(conn, loc.lab_id, blob.sha256, extracted)
        _embed_chunks(conn, rt.embedder, loc.lab_id, blob.sha256)
        write_preview(conn, rt.previews, rt.ffmpeg, loc.lab_id, blob, data)
        # The bytes are in hand now; reading them again later would mean a second download.
        if blob.kind is FileKind.SPREADSHEET:
            data_tables.build(conn, rt.previews, loc.lab_id, blob.sha256, data)
    except FILE_ERRORS as e:
        log.info("location %s failed: %s", loc.id, e)
        _mark_failed(conn, loc, str(e))
        return Outcome.FAILED
    _mark_indexed(conn, loc)
    return Outcome.INDEXED


def _store_blob(conn: psycopg.Connection, loc: Location, data: bytes) -> Blob:
    sha = hashlib.sha256(data).hexdigest()
    kind, mime = detect(loc.original_name, data)
    with conn.transaction():
        conn.execute(
            "insert into blobs (sha256, size, mime, file_kind) values (%s, %s, %s, %s)"
            " on conflict (sha256) do nothing",
            (sha, len(data), mime, kind),
        )
        conn.execute(
            "update file_locations set sha256 = %s where id = %s and source_rev = %s",
            (sha, loc.id, loc.source_rev),
        )
        # The first location to store a blob decides its kind; later ones follow it.
        stored = conn.execute(
            "select file_kind, mime from blobs where sha256 = %s", (sha,)
        ).fetchone()
    assert stored is not None
    return Blob(sha, FileKind(stored[0]), stored[1])


# Errors from linking that belong to the request, not the system: the person left the lab, or
# the page was archived or removed while the bytes were on their way.
STALE_LINK = {"42501", "BL102", "BL103"}


def link_pending(conn: psycopg.Connection, location_id: UUID, sha256: str) -> None:
    """Links this file to the pages it was added to before its bytes were verified. Each link
    is made as the person who asked, so the page's own checks apply and the audit log names
    them; a link that can no longer be made is dropped."""
    pending = conn.execute(
        "select protocol_id, requested_by from pending_protocol_files where location_id = %s",
        (location_id,),
    ).fetchall()
    for protocol_id, requested_by in pending:
        try:
            with conn.transaction():
                if requested_by is not None:
                    conn.execute(
                        "select set_config('request.jwt.claims', %s, true)",
                        (json.dumps({"sub": str(requested_by)}),),
                    )
                    conn.execute("select link_protocol_file(%s, %s)", (protocol_id, sha256))
                _drop_pending(conn, protocol_id, location_id)
        except psycopg.Error as e:
            if e.sqlstate not in STALE_LINK:
                raise
            log.info("dropped the link of %s to page %s: %s", location_id, protocol_id, e)
            _drop_pending(conn, protocol_id, location_id)


def _drop_pending(conn: psycopg.Connection, protocol_id: UUID, location_id: UUID) -> None:
    conn.execute(
        "delete from pending_protocol_files where protocol_id = %s and location_id = %s",
        (protocol_id, location_id),
    )


def extractor_for(
    rt: Runtime, conn: psycopg.Connection, loc: Location, blob: Blob
) -> Extractor | None:
    # Only a recording someone made as a talk-through or a run's debrief answer is transcribed,
    # whatever its bytes sniff as. Other audio is indexed by name: nobody pays to transcribe an
    # archive by accident.
    is_recording = conn.execute(
        "select 1 from talk_throughs where location_id = %(id)s"
        " union all select 1 from run_debrief_answers where location_id = %(id)s",
        {"id": loc.id},
    ).fetchone()
    if is_recording is not None:
        return TranscriptExtractor(rt.transcriber, blob.mime)
    return EXTRACTORS.get(blob.kind)


def extract_cached(
    conn: psycopg.Connection, extractor: Extractor | None, lab_id: UUID, blob: Blob, data: bytes
) -> Extracted | None:
    """Cached by (sha256, extractor, version), so no file is read twice, nor any audio heard
    twice by the same transcriber."""
    if extractor is None:
        return None
    row = conn.execute(
        "select kind, content, meta from extractions"
        " where sha256 = %s and extractor = %s and extractor_version = %s",
        (blob.sha256, extractor.name, extractor.version),
    ).fetchone()
    if row is not None:
        return Extracted(row[0], row[1], row[2])
    extracted = run_extractor(extractor, data)
    with conn.transaction():
        conn.execute(
            "insert into extractions (sha256, extractor, extractor_version, kind, content, meta)"
            " values (%s, %s, %s, %s, %s, %s) on conflict do nothing",
            (
                blob.sha256,
                extractor.name,
                extractor.version,
                extracted.kind,
                extracted.content,
                Jsonb(extracted.meta),
            ),
        )
        if extracted.kind is ExtractionKind.TRANSCRIPT:
            _record_transcription(conn, lab_id, blob.sha256, extractor, extracted)
    return extracted


def _record_transcription(
    conn: psycopg.Connection, lab_id: UUID, sha256: str, extractor: Extractor, t: Extracted
) -> None:
    """Transcription goes in the cost ledger beside model calls, for the lab that paid."""
    conn.execute(
        "insert into model_calls (lab_id, sha256, purpose, model, prompt_version, output,"
        " input_tokens, output_tokens, cost_usd)"
        " values (%s, %s, 'transcript', %s, %s, %s, 0, 0, %s) on conflict do nothing",
        (
            lab_id,
            sha256,
            extractor.name,
            extractor.version,
            Jsonb({"duration_s": t.meta.get("duration_s"), "chars": len(t.content)}),
            t.meta.get("cost_usd", "0"),
        ),
    )
    log.info(
        "transcribed %s with %s: %ss of audio, $%s",
        sha256[:12],
        extractor.name,
        t.meta.get("duration_s"),
        t.meta.get("cost_usd"),
    )


# An unchanged chunk keeps its embedding; a changed one drops it so the embed step redoes it.
UPSERT_CHUNK = """
insert into chunks as c (lab_id, sha256, ord, text) values (%s, %s, %s, %s)
on conflict (lab_id, sha256, ord) do update set
  text = excluded.text,
  embedding = case when c.text = excluded.text then c.embedding end,
  embed_model = case when c.text = excluded.text then c.embed_model end
"""


def _write_chunks(
    conn: psycopg.Connection, lab_id: UUID, sha256: str, extracted: Extracted | None
) -> None:
    with conn.transaction():
        # Duplicates of one blob process concurrently; whoever writes last must see every
        # location's sha256, and each job sets its sha256 before it gets here.
        conn.execute(
            "select pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"{lab_id}/{sha256}",)
        )
        paths = [
            r[0]
            for r in conn.execute(
                "select distinct path from file_locations"
                " where lab_id = %s and sha256 = %s and deleted_at is null order by path",
                (lab_id, sha256),
            )
        ]
        body = "\n\n".join(
            t for t in (extracted.content if extracted else "", caption_text(conn, sha256)) if t
        )
        texts = [name_chunk(paths), *text_chunks(body)]
        with conn.cursor() as cur:
            cur.executemany(
                UPSERT_CHUNK, [(lab_id, sha256, ord, text) for ord, text in enumerate(texts)]
            )
        conn.execute(
            "delete from chunks where lab_id = %s and sha256 = %s and ord >= %s",
            (lab_id, sha256, len(texts)),
        )


def caption_text(conn: psycopg.Connection, sha256: str) -> str:
    row = conn.execute(
        "select content from extractions where sha256 = %s and kind = 'image_caption'"
        " order by created_at desc limit 1",
        (sha256,),
    ).fetchone()
    return row[0] if row else ""


def stored_extraction(conn: psycopg.Connection, sha256: str, kind: FileKind) -> Extracted | None:
    if kind in (FileKind.AUDIO, FileKind.VIDEO):
        row = conn.execute(
            "select kind, content, meta from extractions where sha256 = %s and kind = 'transcript'"
            " order by created_at desc limit 1",
            (sha256,),
        ).fetchone()
        return Extracted(row[0], row[1], row[2]) if row else None
    extractor = EXTRACTORS.get(kind)
    if extractor is None:
        return None
    row = conn.execute(
        "select kind, content, meta from extractions"
        " where sha256 = %s and extractor = %s and extractor_version = %s",
        (sha256, extractor.name, extractor.version),
    ).fetchone()
    return Extracted(row[0], row[1], row[2]) if row else None


def rechunk(
    conn: psycopg.Connection, embedder: Embedder, lab_id: UUID, sha256: str, kind: FileKind
) -> None:
    """Rewrites a blob's chunks from what's stored, after a new caption arrives."""
    _write_chunks(conn, lab_id, sha256, stored_extraction(conn, sha256, kind))
    _embed_chunks(conn, embedder, lab_id, sha256)


def _embed_chunks(conn: psycopg.Connection, embedder: Embedder, lab_id: UUID, sha256: str) -> None:
    todo = conn.execute(
        "select ord, text from chunks where lab_id = %s and sha256 = %s"
        " and embed_model is distinct from %s order by ord",
        (lab_id, sha256, embedder.model_name),
    ).fetchall()
    if not todo:
        return
    vectors = embedder.embed_documents([text for _, text in todo])
    with conn.transaction(), conn.cursor() as cur:
        # Matching on text drops a vector if a concurrent rewrite changed the chunk meanwhile.
        cur.executemany(
            "update chunks set embedding = %s::vector, embed_model = %s"
            " where lab_id = %s and sha256 = %s and ord = %s and text = %s",
            [
                (vector, embedder.model_name, lab_id, sha256, ord, text)
                for (ord, text), vector in zip(todo, vectors, strict=True)
            ],
        )


def write_preview(
    conn: psycopg.Connection,
    store: PreviewStore,
    ffmpeg: Ffmpeg,
    lab_id: UUID,
    blob: Blob,
    data: bytes,
) -> None:
    exists = conn.execute(
        "select 1 from previews where lab_id = %s and sha256 = %s", (lab_id, blob.sha256)
    ).fetchone()
    if exists:
        return
    # A video's poster is a nicety: without ffmpeg, or from a frame it can't read, there's none.
    if blob.kind is FileKind.VIDEO:
        preview = poster(ffmpeg, data)
    else:
        preview = render_preview(blob.kind, data)
    if preview is None:
        return
    key = preview_key(lab_id, blob.sha256)
    store.put(key, preview.webp)
    conn.execute(
        "insert into previews (lab_id, sha256, storage_key, width, height)"
        " values (%s, %s, %s, %s, %s) on conflict (lab_id, sha256) do update set"
        " storage_key = excluded.storage_key, width = excluded.width, height = excluded.height",
        (lab_id, blob.sha256, key, preview.width, preview.height),
    )


def _mark_indexed(conn: psycopg.Connection, loc: Location) -> None:
    # Guarded by source_rev: if a rescan saw a newer revision meanwhile, that job finishes it.
    conn.execute(
        "update file_locations set index_state = 'indexed', index_error = null,"
        " indexed_at = now() where id = %s and source_rev = %s and index_state = 'pending'",
        (loc.id, loc.source_rev),
    )


def _mark_failed(conn: psycopg.Connection, loc: Location, error: str) -> None:
    conn.execute(
        "update file_locations set index_state = 'failed', index_error = %s"
        " where id = %s and source_rev = %s and index_state = 'pending'",
        (error[:2000], loc.id, loc.source_rev),
    )
