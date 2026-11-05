"""Similar-in-meaning neighbors for the lab map (decisions.md, "the lab map").

A file's vector is the mean of its content chunks' embeddings (chunk 0, the name and path, is
left out). A trigger on chunks marks the vector stale whenever a content chunk is written,
re-embedded or removed; this module redoes stale vectors and keeps each file's list of its K
nearest files above a similarity floor. Lists are cached in file_neighbors and never computed
per request.

When a vector changes, three kinds of list can change: its own; every list that holds it (it
may have moved away); and the lists it should now enter (it moved closer to them). The last
are found from its own nearest candidates: a candidate whose list is short or whose farthest
neighbor is less similar than this file gets its list redone. Each list is one nearest-vector
query, so a changed file costs a handful of queries, not a pass over the lab.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from enum import Enum
from uuid import UUID

import psycopg

from bl_worker.db import lab_lock
from bl_worker.embed import HASH, QWEN
from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

# How many neighbors a file keeps, and how many nearest files are checked for lists a changed
# file should enter.
K = 5
CANDIDATES = 50

# The floor depends on the model: cosine similarities from different models sit in different
# ranges. Qwen's was read off the sample lab (decisions.md, "the lab map": unrelated lab files
# sit around 0.35 to 0.55, the same procedure or sample above 0.7); the hash embedder's is for
# tests, where only shared words make texts close.
MIN_SIMILARITY = {QWEN: 0.7, HASH: 0.3}

# A file's chunks are written in a few steps (text, then embeddings); this lets them settle.
SETTLE = "3 seconds"
# One job works through a lab's stale vectors in batches for up to this long, then hands back.
BATCH = 500
BUDGET_S = 120.0

STALE = f"""
select v.sha256, v.chunks_changed_at from file_vectors v
where v.lab_id = %(lab)s and (v.computed_at is null or v.computed_at < v.chunks_changed_at)
  and v.chunks_changed_at < clock_timestamp() - interval '{SETTLE}'
  and v.sha256 <> all (%(skip)s)
order by v.chunks_changed_at, v.sha256
limit %(limit)s
"""

STALE_LABS = f"""
select distinct v.lab_id from file_vectors v
where (v.computed_at is null or v.computed_at < v.chunks_changed_at)
  and v.chunks_changed_at < clock_timestamp() - interval '{SETTLE}'
"""

# The mean of the content chunks, once every one of them carries this model's embedding. A
# photo's only text before it's described is its EXIF (camera, date, size), which would make
# every photo from one phone "similar", so a photo gets a vector once it has a caption.
MEAN = """
select count(*) filter (where c.embed_model is distinct from %(model)s),
  case when not exists (
    select 1 from blobs b where b.sha256 = %(sha)s and b.file_kind = 'image'
      and not exists (
        select 1 from extractions e where e.sha256 = b.sha256 and e.kind = 'image_caption'
      )
  ) then l2_normalize(avg(c.embedding) filter (where c.embed_model = %(model)s)) end
from chunks c where c.lab_id = %(lab)s and c.sha256 = %(sha)s and c.ord > 0
"""

# Nearest live files by cosine similarity. The HNSW index answers it; iterative scans keep
# looking past other labs' vectors until the lab has enough.
NEAREST = """
select v.sha256, 1 - (v.embedding <=> %(vec)s) as similarity
from file_vectors v
where v.lab_id = %(lab)s and v.sha256 <> %(sha)s and v.embed_model = %(model)s
  and exists (
    select 1 from file_locations fl
    where fl.lab_id = v.lab_id and fl.sha256 = v.sha256 and fl.deleted_at is null
  )
order by v.embedding <=> %(vec)s
limit %(n)s
"""


@dataclass(frozen=True)
class Refreshed:
    vectors: int
    changed: int
    lists: int
    seconds: float


def stale_labs(conn: psycopg.Connection) -> list[UUID]:
    return [r[0] for r in conn.execute(STALE_LABS)]


def floor_for(model: str) -> float:
    if model not in MIN_SIMILARITY:
        raise ValueError(f"no similarity floor for {model!r}; add one to MIN_SIMILARITY")
    return MIN_SIMILARITY[model]


def refresh_lab(rt: Runtime, lab_id: UUID, *, budget_s: float = BUDGET_S) -> Refreshed:
    """Redoes the lab's stale vectors and every list they touch, batch by batch, until none
    are left or the budget runs out. Safe to re-run from any point: a vector is marked done
    only with the change time it was computed from, and a list is replaced whole."""
    start = time.monotonic()
    model = rt.embedder.model_name
    floor = floor_for(model)
    vectors = changed = lists = 0
    with rt.pool.connection() as conn, lab_lock(conn, lab_id, exclusive=False):
        conn.execute("set hnsw.iterative_scan = relaxed_order")
        conn.execute("set hnsw.ef_search = 100")
        # Files whose chunks are still being embedded; the next job tries them again.
        waiting: list[str] = []
        while time.monotonic() - start < budget_s:
            todo = conn.execute(STALE, {"lab": lab_id, "limit": BATCH, "skip": waiting}).fetchall()
            if not todo:
                break
            moved = []
            for sha, seen in todo:
                outcome = _refresh_vector(conn, lab_id, sha, seen, model)
                if outcome is Vector.WAITING:
                    waiting.append(sha)
                elif outcome is Vector.MOVED:
                    moved.append(sha)
            vectors += len(todo) - sum(1 for sha, _ in todo if sha in waiting)
            changed += len(moved)
            with conn.transaction():
                affected = _affected(conn, lab_id, moved, model, floor)
                for sha in sorted(affected):
                    _redo_list(conn, lab_id, sha, model, floor)
            lists += len(affected)
    took = time.monotonic() - start
    if vectors:
        log.info(
            "neighbors in lab %s: %d vectors, %d changed, %d lists in %.2fs",
            lab_id,
            vectors,
            changed,
            lists,
            took,
        )
    return Refreshed(vectors, changed, lists, took)


class Vector(Enum):
    MOVED = "moved"
    SAME = "same"
    # Some content chunk has no embedding from this model yet; the vector stays stale.
    WAITING = "waiting"


def _refresh_vector(
    conn: psycopg.Connection, lab_id: UUID, sha256: str, seen: object, model: str
) -> Vector:
    """Recomputes one file's vector."""
    with conn.transaction():
        row = conn.execute(MEAN, {"lab": lab_id, "sha": sha256, "model": model}).fetchone()
        assert row is not None
        unembedded, vec = row
        if unembedded:
            return Vector.WAITING
        old = conn.execute(
            "select embedding is null, embed_model,"
            " case when embedding is not null then embedding <=> %(vec)s::vector end"
            " from file_vectors where lab_id = %(lab)s and sha256 = %(sha)s for update",
            {"vec": vec, "lab": lab_id, "sha": sha256},
        ).fetchone()
        if old is None:
            return Vector.SAME
        conn.execute(
            "update file_vectors set embedding = %(vec)s, embed_model = %(model)s,"
            " computed_at = %(seen)s where lab_id = %(lab)s and sha256 = %(sha)s",
            {
                "vec": vec,
                "model": model if vec is not None else None,
                "seen": seen,
                "lab": lab_id,
                "sha": sha256,
            },
        )
    was_empty, old_model, distance = old
    if was_empty or vec is None:
        moved = was_empty != (vec is None)
    else:
        moved = old_model != model or distance is None or distance > 1e-6
    return Vector.MOVED if moved else Vector.SAME


def _vector(conn: psycopg.Connection, lab_id: UUID, sha256: str, model: str) -> object:
    row = conn.execute(
        "select embedding from file_vectors where lab_id = %s and sha256 = %s and embed_model = %s",
        (lab_id, sha256, model),
    ).fetchone()
    return row[0] if row else None


def _nearest(
    conn: psycopg.Connection, lab_id: UUID, sha256: str, vec: object, model: str, n: int
) -> list[tuple[str, float]]:
    rows = conn.execute(
        NEAREST, {"lab": lab_id, "sha": sha256, "vec": vec, "model": model, "n": n}
    ).fetchall()
    # Iterative scans may hand rows back slightly out of order.
    return sorted(((r[0], float(r[1])) for r in rows), key=lambda r: (-r[1], r[0]))


def _affected(
    conn: psycopg.Connection, lab_id: UUID, moved: list[str], model: str, floor: float
) -> set[str]:
    """Every list a moved vector can change: its own, the lists holding it, and the lists it
    is now close enough to enter."""
    affected = set(moved)
    if not moved:
        return affected
    holders = conn.execute(
        "select distinct sha256 from file_neighbors where lab_id = %s and neighbor = any(%s)",
        (lab_id, moved),
    )
    affected.update(r[0] for r in holders)
    for sha in moved:
        vec = _vector(conn, lab_id, sha, model)
        if vec is None:
            continue
        near = [
            (b, s) for b, s in _nearest(conn, lab_id, sha, vec, model, CANDIDATES) if s >= floor
        ]
        if not near:
            continue
        lists = {
            r[0]: (r[1], r[2])
            for r in conn.execute(
                "select sha256, count(*), min(similarity) from file_neighbors"
                " where lab_id = %s and sha256 = any(%s) group by sha256",
                (lab_id, [b for b, _ in near]),
            )
        }
        for b, s in near:
            count, weakest = lists.get(b, (0, None))
            if count < K or weakest is None or s > weakest:
                affected.add(b)
    return affected


def _redo_list(
    conn: psycopg.Connection, lab_id: UUID, sha256: str, model: str, floor: float
) -> None:
    conn.execute("delete from file_neighbors where lab_id = %s and sha256 = %s", (lab_id, sha256))
    vec = _vector(conn, lab_id, sha256, model)
    if vec is None:
        return
    keep = [(b, s) for b, s in _nearest(conn, lab_id, sha256, vec, model, K) if s >= floor]
    if not keep:
        return
    with conn.cursor() as cur:
        cur.executemany(
            "insert into file_neighbors (lab_id, sha256, neighbor, similarity)"
            " values (%s, %s, %s, %s)",
            [(lab_id, sha256, b, min(1.0, s)) for b, s in keep],
        )
