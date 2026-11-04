from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from bl_worker.chunking import name_chunk, text_chunks
from bl_worker.domain import FileKind, SourceKind, SourceReadError, SourceRow
from bl_worker.embed import Embedder
from bl_worker.extract import EXTRACTORS, Extracted, ExtractionFailed, run_extractor
from bl_worker.filekind import detect
from bl_worker.previews import PreviewFailed, PreviewStore, preview_key, render_preview
from bl_worker.runtime import Runtime
from bl_worker.sources import build_reader

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
        """
        select fl.id, fl.lab_id, fl.external_id, fl.original_name, fl.source_rev,
          s.id, s.lab_id, s.kind, s.root_path, s.token_ciphertext, s.cursor
        from file_locations fl join sources s on s.id = fl.source_id
        where fl.id = %s and fl.index_state = 'pending' and fl.deleted_at is null
          and s.root_path is not null
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
        loc = load_pending(conn, location_id)
        if loc is None:
            return Outcome.SKIPPED
        try:
            data = build_reader(loc.source, rt.settings, rt.previews).read(loc.external_id)
            blob = _store_blob(conn, loc, data)
            extracted = _extract(conn, blob, data)
            _write_chunks(conn, loc.lab_id, blob.sha256, extracted)
            _embed_chunks(conn, rt.embedder, loc.lab_id, blob.sha256)
            _write_preview(conn, rt.previews, loc.lab_id, blob, data)
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


def _extract(conn: psycopg.Connection, blob: Blob, data: bytes) -> Extracted | None:
    extractor = EXTRACTORS.get(blob.kind)
    if extractor is None:
        return None
    cached = stored_extraction(conn, blob.sha256, blob.kind)
    if cached is not None:
        return cached
    extracted = run_extractor(extractor, data)
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
    return extracted


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


def _write_preview(
    conn: psycopg.Connection, store: PreviewStore, lab_id: UUID, blob: Blob, data: bytes
) -> None:
    exists = conn.execute(
        "select 1 from previews where lab_id = %s and sha256 = %s", (lab_id, blob.sha256)
    ).fetchone()
    if exists:
        return
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
