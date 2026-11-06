"""Numbers for the lab map (decisions.md, "the lab map"). Local Postgres only.

  uv run python scripts/measure_map.py calibrate   # Qwen on the ~50-file sample lab: how similar
                                                   # related and unrelated files are
  uv run python scripts/measure_map.py scale       # a generated 20,000-file lab: neighbor build
                                                   # and refresh cost, map query times and sizes

Each run builds its own database (--db) and drops it at the end unless --keep is given.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import random
import statistics
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import psycopg

from bl_worker import neighbors, process, scan
from bl_worker.config import Settings
from bl_worker.db import configure, migrate
from bl_worker.embed import DIM, QWEN, HashEmbedder
from bl_worker.runtime import build_runtime

ADMIN = "postgresql://localhost/postgres"


@contextmanager
def scratch_db(name: str, keep: bool):
    with psycopg.connect(ADMIN, autocommit=True) as admin:
        admin.execute(f"drop database if exists {name} with (force)")
        admin.execute(f"create database {name}")
    url = f"postgresql://localhost/{name}"
    migrate(url, test_stub=True)
    try:
        yield url
    finally:
        if not keep:
            with psycopg.connect(ADMIN, autocommit=True) as admin:
                admin.execute(f"drop database if exists {name} with (force)")


def settings(url: str, store: Path, model: str) -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        database_url=url,
        token_encryption_key=base64.b64encode(bytes(32)).decode(),  # type: ignore[arg-type]
        embed_model=model,
        anthropic_api_key=None,
        preview_store="local",
        preview_dir=store,
    )


def make_lab(conn: psycopg.Connection, name: str) -> tuple[uuid.UUID, uuid.UUID]:
    user = uuid.uuid4()
    conn.execute("insert into auth.users (id, email) values (%s, %s)", (user, f"{user}@x.edu"))
    (lab,) = conn.execute("insert into labs (name) values (%s) returning id", (name,)).fetchone()  # type: ignore[misc]
    conn.execute(
        "insert into members (lab_id, user_id, role) values (%s, %s, 'admin')", (lab, user)
    )
    return lab, user


# -- calibrate ---------------------------------------------------------------------------


def calibrate(args: argparse.Namespace) -> None:
    from make_sample_lab import make

    with tempfile.TemporaryDirectory() as tmp, scratch_db(args.db, args.keep) as url:
        folder = Path(tmp) / "lab"
        make(folder)
        rt = build_runtime(settings(url, Path(tmp) / "store", QWEN))
        with rt.pool.connection() as conn:
            lab, _ = make_lab(conn, "sample")
            (source,) = conn.execute(
                "insert into sources (lab_id, kind, root_path) values (%s, 'local', %s)"
                " returning id",
                (lab, str(folder)),
            ).fetchone()  # type: ignore[misc]
            t = time.monotonic()
            for loc in scan.scan_source(conn, rt.settings, source):
                process.process_location(rt, loc)
            print(f"scanned and embedded in {time.monotonic() - t:.1f}s")
            conn.execute(
                "update file_vectors set chunks_changed_at = chunks_changed_at"
                " - interval '1 minute'"
            )
        done = neighbors.refresh_lab(rt, lab)
        print(f"refresh: {done}")
        with rt.pool.connection() as conn:
            rows = conn.execute(
                """
                select a.path, b.path, 1 - (va.embedding <=> vb.embedding)
                from file_vectors va
                join file_vectors vb on vb.lab_id = va.lab_id and vb.sha256 > va.sha256
                join lateral (select path from file_locations where sha256 = va.sha256
                  order by path limit 1) a on true
                join lateral (select path from file_locations where sha256 = vb.sha256
                  order by path limit 1) b on true
                where va.lab_id = %s and va.embedding is not null and vb.embedding is not null
                order by 3 desc
                """,
                (lab,),
            ).fetchall()
            kept = conn.execute(
                "select count(*) from file_neighbors where lab_id = %s", (lab,)
            ).fetchone()
        sims = [r[2] for r in rows]
        print(
            f"{len(sims)} pairs of {done.vectors} files with vectors; {kept[0]} neighbor rows kept"
        )
        for q in (0.5, 0.75, 0.9, 0.95, 0.99):
            print(f"  p{int(q * 100)} similarity {np.quantile(sims, q):.3f}")
        print("closest pairs:")
        for a, b, s in rows[:25]:
            print(f"  {s:.3f}  {a}  ~  {b}")
        print("around the floor:")
        for a, b, s in rows:
            if abs(s - neighbors.MIN_SIMILARITY[QWEN]) < 0.03:
                print(f"  {s:.3f}  {a}  ~  {b}")
        rt.close()


# -- scale -------------------------------------------------------------------------------


class Stand(HashEmbedder):
    """Never embeds anything here; it names the model the generated vectors claim."""

    model_name = QWEN


def unit(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def generate(
    conn: psycopg.Connection, lab: uuid.UUID, user: uuid.UUID, n_files: int, rng: random.Random
) -> dict:
    """A pilot-sized lab: n files over 50 experiments, 15 people, 30 protocols and 4
    instruments, skewed the way a real lab is (a few big experiments and people). Each file has
    one content chunk whose embedding sits near its experiment's topic."""
    np_rng = np.random.default_rng(7)
    conn.execute("drop index chunks_embedding_idx")  # search isn't measured; it only slows loading
    (source,) = conn.execute(
        "insert into sources (lab_id, kind, root_path) values (%s, 'local', '/gen') returning id",
        (lab,),
    ).fetchone()  # type: ignore[misc]
    protocols = []
    for i in range(30):
        with conn.transaction():
            conn.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(user),))
            (pid,) = conn.execute(
                "select protocol_id from create_protocol(%s, 'protocol', %s, '')",
                (lab, f"Protocol {i + 1}"),
            ).fetchone()  # type: ignore[misc]
        protocols.append(pid)
    experiments = [
        conn.execute(
            "insert into experiments (lab_id, name, protocol_id) values (%s, %s, %s) returning id",
            (lab, f"Experiment {i + 1}", protocols[i % 30] if i % 5 else None),
        ).fetchone()[0]  # type: ignore[index]
        for i in range(50)
    ]
    people = [
        conn.execute(
            "insert into people (lab_id, display_name) values (%s, %s) returning id",
            (lab, f"Person {i + 1}"),
        ).fetchone()[0]  # type: ignore[index]
        for i in range(15)
    ]
    instruments = ["SpectraMax M5", "AKTA pure", "QuantStudio 5", "NanoDrop One"]
    exp_weights = [1 / (i + 1) ** 0.8 for i in range(50)]
    person_weights = [1 / (i + 1) ** 0.6 for i in range(15)]
    # Each experiment has four kinds of file (a protocol's runs, an instrument's exports...);
    # most files sit close to their kind, one in five reads like nothing else.
    topics = unit(np_rng.normal(size=(50, DIM)))
    kinds = unit(np_rng.normal(size=(50, 4, DIM)))
    shas = [f"{i:064x}" for i in range(1, n_files + 1)]
    exps = rng.choices(range(50), weights=exp_weights, k=n_files)
    kind = np_rng.integers(0, 4, size=n_files)
    noise = np.where(np_rng.random(n_files) < 0.2, 0.06, 0.012)[:, None]
    vectors = unit(
        topics[exps] + 0.7 * kinds[exps, kind] + noise * np_rng.normal(size=(n_files, DIM))
    )
    with conn.cursor() as cur:
        with cur.copy("copy blobs (sha256, size, mime, file_kind) from stdin") as copy:
            for sha in shas:
                copy.write_row((sha, 1000, "text/plain", "text"))
        with cur.copy(
            "copy file_locations (lab_id, source_id, external_id, path, original_name, size,"
            " modified_at, source_rev, sha256, index_state) from stdin"
        ) as copy:
            for i, sha in enumerate(shas):
                name = f"run_{i:05d}.csv"
                copy.write_row(
                    (
                        lab,
                        source,
                        name,
                        f"/E{exps[i] + 1}/{name}",
                        name,
                        1000,
                        f"2026-{1 + i % 10:02d}-{1 + i % 28:02d}T12:00:00Z",
                        "r1",
                        sha,
                        "indexed",
                    )
                )
        with cur.copy(
            "copy labels (lab_id, sha256, status, clean_name, experiment_id, person_id,"
            " instrument, confidence, source) from stdin"
        ) as copy:
            for i, sha in enumerate(shas):
                person = (
                    rng.choices(people, weights=person_weights)[0] if rng.random() < 0.9 else None
                )
                instrument = rng.choice(instruments) if rng.random() < 0.6 else None
                experiment = experiments[exps[i]] if rng.random() < 0.95 else None
                copy.write_row(
                    (
                        lab,
                        sha,
                        "accepted",
                        f"Run {i:05d}",
                        experiment,
                        person,
                        instrument,
                        0.9,
                        "rules",
                    )
                )
        with cur.copy(
            "copy chunks (lab_id, sha256, ord, text, embedding, embed_model) from stdin"
        ) as copy:
            for i, sha in enumerate(shas):
                copy.write_row((lab, sha, 0, f"run_{i:05d}.csv", None, None))
                copy.write_row(
                    (
                        lab,
                        sha,
                        1,
                        "readings",
                        "[" + ",".join(f"{x:.5f}" for x in vectors[i]) + "]",
                        QWEN,
                    )
                )
        attached = rng.sample(shas, 600)
        with conn.transaction():
            conn.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(user),))
            with cur.copy("copy protocol_files (protocol_id, lab_id, sha256) from stdin") as copy:
                for j, sha in enumerate(attached):
                    copy.write_row((protocols[j % 30], lab, sha))
    conn.execute("analyze")
    return {
        "protocols": protocols,
        "experiments": experiments,
        "people": people,
        "shas": shas,
        "vectors": vectors,
    }


@contextmanager
def as_member(conn: psycopg.Connection, user: uuid.UUID):
    with conn.transaction(force_rollback=True):
        conn.execute("set local role authenticated")
        conn.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(user),))
        yield conn


def timed(
    conn: psycopg.Connection, sql: str, params: tuple, runs: int = 5
) -> tuple[float, int, int]:
    """Median ms of the call, then the JSON's raw and gzipped bytes."""
    times = []
    out = None
    for _ in range(runs):
        t = time.perf_counter()
        (out,) = conn.execute(sql, params).fetchone()  # type: ignore[misc]
        times.append((time.perf_counter() - t) * 1000)
    raw = json.dumps(out, separators=(",", ":")).encode()
    return statistics.median(times), len(raw), len(gzip.compress(raw, 6))


def scale(args: argparse.Namespace) -> None:
    rng = random.Random(4821)
    with tempfile.TemporaryDirectory() as tmp, scratch_db(args.db, args.keep) as url:
        rt = build_runtime(settings(url, Path(tmp) / "store", QWEN), embedder=Stand())
        with psycopg.connect(url, autocommit=True) as conn:
            configure(conn)
            lab, user = make_lab(conn, "pilot")
            t = time.monotonic()
            g = generate(conn, lab, user, args.files, rng)
            print(f"generated {args.files} files in {time.monotonic() - t:.1f}s")
            conn.execute(
                "update file_vectors set chunks_changed_at = chunks_changed_at"
                " - interval '1 minute'"
            )

        full = neighbors.refresh_lab(rt, lab, budget_s=3600)
        print(
            f"full build: {full.vectors} vectors, {full.lists} lists in {full.seconds:.1f}s"
            f" ({full.seconds / max(full.vectors, 1) * 1000:.2f} ms a file)"
        )

        with psycopg.connect(url, autocommit=True) as conn:
            configure(conn)
            rows, size = conn.execute(
                "select count(*), pg_total_relation_size('file_neighbors')"
                " + pg_total_relation_size('file_vectors') from file_neighbors where lab_id = %s",
                (lab,),
            ).fetchone()  # type: ignore[misc]
            per = conn.execute(
                "select avg(n) from (select count(*) n from file_neighbors"
                " where lab_id = %s group by sha256) x",
                (lab,),
            ).fetchone()[0]  # type: ignore[index]
            print(
                f"  {rows} neighbor rows ({float(per):.2f} a listed file);"
                f" vectors+lists take {size / 1e6:.0f} MB"
            )
            for n in (1, 10, 100):
                moved = rng.sample(g["shas"], n)
                np_rng = np.random.default_rng(n)
                with conn.cursor() as cur:
                    for sha in moved:
                        # The file now reads like some other file: it moves to another topic.
                        other = g["vectors"][rng.randrange(len(g["shas"]))]
                        v = unit(other + np_rng.normal(scale=0.03, size=DIM))
                        cur.execute(
                            "update chunks set embedding = %s::vector"
                            " where lab_id = %s and sha256 = %s and ord = 1",
                            ("[" + ",".join(f"{x:.5f}" for x in v) + "]", lab, sha),
                        )
                conn.execute(
                    "update file_vectors set chunks_changed_at = clock_timestamp()"
                    " - interval '1 minute' where lab_id = %s and computed_at < chunks_changed_at",
                    (lab,),
                )
                inc = neighbors.refresh_lab(rt, lab)
                print(
                    f"refresh after {n} files changed: {inc.moved} moved,"
                    f" {inc.lists} lists redone in {inc.seconds * 1000:.0f} ms"
                )

            # The member's side, with RLS on.
            biggest_person = conn.execute(
                "select person_id from labels where lab_id = %s and person_id is not null"
                " group by 1 order by count(*) desc limit 1",
                (lab,),
            ).fetchone()[0]  # type: ignore[index]
            biggest_exp = conn.execute(
                "select experiment_id from labels where lab_id = %s and experiment_id is not null"
                " group by 1 order by count(*) desc limit 1",
                (lab,),
            ).fetchone()[0]  # type: ignore[index]
            some_file = "file:" + g["shas"][123]
            calls = [
                ("lab_map (hubs)", "select lab_map(%s)", (lab,)),
                (
                    "lab_map_hub person, 400 files",
                    "select lab_map_hub(%s, %s)",
                    (lab, f"person:{biggest_person}"),
                ),
                (
                    "lab_map_hub person, similar",
                    "select lab_map_hub(%s, %s, 400, true, %s)",
                    (lab, f"person:{biggest_person}", [f"experiment:{biggest_exp}"]),
                ),
                (
                    "lab_map_hub person, 2000 files",
                    "select lab_map_hub(%s, %s, 2000)",
                    (lab, f"person:{biggest_person}"),
                ),
                (
                    "lab_map_local file, depth 1",
                    "select lab_map_local(%s, %s, 1)",
                    (lab, some_file),
                ),
                (
                    "lab_map_local file, depth 1, similar",
                    "select lab_map_local(%s, %s, 1, true)",
                    (lab, some_file),
                ),
                (
                    "lab_map_local file, depth 2",
                    "select lab_map_local(%s, %s, 2)",
                    (lab, some_file),
                ),
                (
                    "lab_map_local file, depth 2, similar",
                    "select lab_map_local(%s, %s, 2, true)",
                    (lab, some_file),
                ),
                (
                    "lab_map_local experiment, depth 1",
                    "select lab_map_local(%s, %s, 1)",
                    (lab, f"experiment:{biggest_exp}"),
                ),
                (
                    "lab_map_local experiment, depth 2",
                    "select lab_map_local(%s, %s, 2)",
                    (lab, f"experiment:{biggest_exp}"),
                ),
                (
                    "lab_map_local protocol, depth 2",
                    "select lab_map_local(%s, %s, 2)",
                    (lab, f"protocol:{g['protocols'][0]}"),
                ),
            ]
            with as_member(conn, user):
                for label, sql, params in calls:
                    ms, raw, gz = timed(conn, sql, params)
                    print(
                        f"{label}: {ms:.0f} ms, {raw / 1024:.1f} KB JSON,"
                        f" {gz / 1024:.1f} KB gzipped"
                    )
                if args.dump:
                    (out,) = conn.execute("select lab_map(%s)", (lab,)).fetchone()  # type: ignore[misc]
                    Path(args.dump).write_text(json.dumps(out))
                    print(f"wrote the hub view to {args.dump}")
        rt.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(required=True)
    c = sub.add_parser("calibrate")
    c.add_argument("--db", default="bl_map_calibrate")
    c.add_argument("--keep", action="store_true")
    c.set_defaults(run=calibrate)
    s = sub.add_parser("scale")
    s.add_argument("--db", default="bl_map_scale")
    s.add_argument("--files", type=int, default=20_000)
    s.add_argument("--keep", action="store_true")
    s.add_argument("--dump", help="write the hub view's JSON here")
    s.set_defaults(run=scale)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
