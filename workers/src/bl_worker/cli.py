from __future__ import annotations

import argparse
import logging
from pathlib import Path
from uuid import UUID

from bl_worker.config import load_checked_settings, load_settings


def cmd_migrate(args: argparse.Namespace) -> None:
    from bl_worker.db import migrate

    applied = migrate(load_checked_settings().database_url, test_stub=args.test_stub)
    print("applied: " + (", ".join(applied) if applied else "nothing, up to date"))


def cmd_worker(args: argparse.Namespace) -> None:
    # Before anything else, so a bad environment is the one thing in the log.
    settings = load_checked_settings()

    import asyncio
    import signal
    import time

    from procrastinate import PsycopgConnector

    from bl_worker.jobs import app
    from bl_worker.runtime import build_runtime

    log = logging.getLogger("bl_worker.cli")
    stop_requested = False

    async def run_once(rt: object) -> None:
        # Procrastinate stops itself quietly when a side task (heartbeat, listener) loses the
        # database, which looks the same as a signal. Owning the signals tells the two apart.
        nonlocal stop_requested
        loop = asyncio.get_running_loop()
        async with app.open_async():
            task = asyncio.create_task(
                app.run_worker_async(
                    concurrency=args.concurrency,
                    additional_context={"runtime": rt},
                    delete_jobs="successful",
                    wait=not args.until_idle,
                    install_signal_handlers=False,
                )
            )

            def on_signal() -> None:
                nonlocal stop_requested
                stop_requested = True
                task.cancel()

            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, on_signal)
            try:
                await task
            except asyncio.CancelledError:
                if not stop_requested:
                    raise
            finally:
                for sig in (signal.SIGINT, signal.SIGTERM):
                    loop.remove_signal_handler(sig)

    backoff = 2.0
    while True:
        started = time.monotonic()
        rt = None
        try:
            rt = build_runtime(settings, pool_size=args.concurrency + 2)
            with app.replace_connector(PsycopgConnector(conninfo=settings.database_url)):
                asyncio.run(run_once(rt))
            if args.until_idle or stop_requested:
                return
            reason = "worker stopped without being asked"
        except Exception:
            # A long-running worker outlives a dropped database (laptop sleep, network blip,
            # pooler restart), however it surfaces: jobs live in Postgres and every step is
            # safe to re-run.
            if args.until_idle or stop_requested:
                raise
            reason = "worker failed"
        finally:
            if rt is not None:
                rt.close()
        if time.monotonic() - started > 300:
            backoff = 2.0
        log.warning("%s; restarting worker in %.0fs", reason, backoff, exc_info=True)
        time.sleep(backoff)
        backoff = min(backoff * 2, 60.0)


def cmd_serve_embed(args: argparse.Namespace) -> None:
    import uvicorn

    from bl_worker.embed import build_embedder
    from bl_worker.embed_api import create_app

    settings = load_checked_settings()
    if settings.embed_api_key is None:
        raise SystemExit("EMBED_API_KEY is required for serve-embed")
    app = create_app(
        settings.embed_api_key.get_secret_value(), lambda: build_embedder(settings.embed_model)
    )
    uvicorn.run(app, host=args.host, port=settings.embed_port)


def cmd_scan_local(args: argparse.Namespace) -> None:
    from bl_worker.db import connect

    folder = Path(args.folder).resolve()
    if not folder.is_dir():
        raise SystemExit(f"{folder} is not a folder")
    with connect(load_settings().database_url) as conn:
        row = conn.execute(
            "select id from sources where lab_id = %s and kind = 'local' and root_path = %s",
            (args.lab_id, str(folder)),
        ).fetchone()
        if row is None:
            row = conn.execute(
                "insert into sources (lab_id, kind, root_path, account_label)"
                " values (%s, 'local', %s, %s) returning id",
                (args.lab_id, str(folder), folder.name),
            ).fetchone()
        assert row is not None
        conn.execute("update sources set scan_requested_at = now() where id = %s", (row[0],))
    print(f"scan requested for source {row[0]} ({folder})")


def cmd_sample_lab(args: argparse.Namespace) -> None:
    import uuid

    from procrastinate import PsycopgConnector

    from bl_worker.db import connect
    from bl_worker.jobs import app
    from bl_worker.labels.evaluate import load_expected, seed_lab

    folder = Path(args.folder).resolve()
    settings = load_settings()
    with connect(settings.database_url) as conn:
        user = uuid.uuid4()
        conn.execute("insert into auth.users (id, email) values (%s, 'sample@lab.edu')", (user,))
        (lab_id,) = conn.execute(
            "insert into labs (name) values ('Sample lab') returning id"
        ).fetchone()  # type: ignore[misc]
        conn.execute("insert into members values (%s, %s, 'admin')", (lab_id, user))
        (source_id,) = conn.execute(
            "insert into sources (lab_id, kind, root_path, account_label, scan_requested_at)"
            " values (%s, 'local', %s, %s, now()) returning id",
            (lab_id, str(folder), folder.name),
        ).fetchone()  # type: ignore[misc]
        seed_lab(conn, lab_id, load_expected())
    with app.replace_connector(PsycopgConnector(conninfo=settings.database_url)) as a, a.open():
        a.configure_task("scan_source").defer(source_id=str(source_id))
    print(lab_id)


def cmd_demo_lab(args: argparse.Namespace) -> None:
    import asyncio
    import time

    from procrastinate import PsycopgConnector

    from bl_worker import demo_lab
    from bl_worker.db import connect
    from bl_worker.embed import HashEmbedder
    from bl_worker.jobs import app
    from bl_worker.runtime import build_runtime

    settings = load_settings()
    with connect(settings.database_url) as conn:
        try:
            admin = demo_lab.find_admin(conn, email=args.admin_email, user_id=args.admin_user)
        except demo_lab.DemoError as e:
            raise SystemExit(str(e)) from e
    if args.delete:
        # Deleting never embeds anything, so the model isn't loaded.
        rt = build_runtime(settings, embedder=HashEmbedder(), pool_size=2)
        try:
            gone = demo_lab.delete(rt, admin)
        finally:
            rt.close()
        print("deleted " + (", ".join(map(str, gone)) if gone else "nothing: no demo lab"))
        return
    log = logging.getLogger("bl_worker.demo_lab")
    rt = build_runtime(settings, pool_size=args.concurrency + 3)

    def left(lab: UUID, files_only: bool) -> dict[str, int]:
        with rt.pool.connection() as c:
            return demo_lab.unsettled(c, lab, files_only=files_only)

    async def work(lab: UUID, files_only: bool, deadline: float) -> dict[str, int]:
        # The real worker, periodic tasks and all, stopped once this lab is done; jobs it
        # started finish first. Other labs' jobs run as they would on any worker.
        async with app.open_async():
            task = asyncio.create_task(
                app.run_worker_async(
                    concurrency=args.concurrency,
                    additional_context={"runtime": rt},
                    delete_jobs="successful",
                    install_signal_handlers=False,
                )
            )
            try:
                while True:
                    remaining = await asyncio.to_thread(left, lab, files_only)
                    if not remaining or time.monotonic() > deadline or task.done():
                        return remaining
                    await asyncio.sleep(2)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    def settle(lab: UUID, files_only: bool) -> None:
        deadline = time.monotonic() + args.timeout
        what = "its files" if files_only else "everything"
        log.info("waiting for the worker to finish %s in lab %s", what, lab)
        if args.no_worker:
            while (remaining := left(lab, files_only)) and time.monotonic() < deadline:
                time.sleep(2)
        else:
            with app.replace_connector(PsycopgConnector(conninfo=settings.database_url)):
                remaining = asyncio.run(work(lab, files_only, deadline))
        if remaining:
            raise SystemExit(f"lab {lab} not settled after {args.timeout}s: {remaining}; run again")

    started = time.monotonic()
    try:
        if args.replace:
            gone = demo_lab.delete(rt, admin)
            if gone:
                print("deleted " + ", ".join(map(str, gone)))
        lab = demo_lab.build(rt, admin, settle)
        with rt.pool.connection() as conn:
            print(demo_lab.summary(conn, lab).text())
            first = conn.execute(
                "select l.name from members m join labs l on l.id = m.lab_id"
                " where m.user_id = %s and l.deletion_requested_at is null"
                " order by m.created_at limit 1",
                (admin,),
            ).fetchone()
        print(f"took {time.monotonic() - started:.0f}s")
        if first is not None and first[0] != demo_lab.LAB_NAME:
            print(f"note: the app opens a user's first lab, which for this user is {first[0]!r}")
    finally:
        rt.close()


def cmd_relabel(args: argparse.Namespace) -> None:
    """The re-label sweep now, start to end, instead of a few files every 10 s: for a lab
    moving to a new label prompt in one go, and to measure what the sweep costs."""
    from bl_worker.labels import job, notes, sweep
    from bl_worker.runtime import build_runtime

    rt = build_runtime(load_settings(), pool_size=4)
    try:
        if rt.models is None:
            raise SystemExit("relabel needs ANTHROPIC_API_KEY")
        with rt.pool.connection() as conn:
            (before,) = conn.execute(
                "select coalesce(sum(cost_usd), 0) from model_calls"
            ).fetchone()  # type: ignore[misc]
        done = 0
        while True:
            with rt.pool.connection() as conn:
                todo = sweep.stale_labels(conn, limit=args.batch)
            if not todo:
                break
            for lab_id, sha in todo:
                job.label_blob(rt, lab_id, sha)
                done += 1
            for _, note_id in notes.tend_notes(rt):
                notes.label_note(rt, note_id)
        with rt.pool.connection() as conn:
            (after,) = conn.execute("select coalesce(sum(cost_usd), 0) from model_calls").fetchone()  # type: ignore[misc]
        print(f"relabeled {done} files for ${after - before:.4f}")
    finally:
        rt.close()


def cmd_eval_labels(args: argparse.Namespace) -> None:
    from bl_worker.db import connect
    from bl_worker.labels.evaluate import load_expected, score

    with connect(args.db) as conn:
        lab_id = args.lab
        if lab_id is None:
            labs = conn.execute("select id from labs").fetchall()
            if len(labs) != 1:
                raise SystemExit(f"{len(labs)} labs in this database; pass --lab")
            lab_id = labs[0][0]
        print(score(conn, lab_id, load_expected()).text())
        if args.findability:
            from bl_worker.embed import build_embedder
            from bl_worker.labels.evaluate import findability

            embedder = build_embedder(load_settings(database_url=args.db).embed_model)
            print(findability(conn, lab_id, embedder.embed_query).text())


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # Hugging Face's hub client logs every HEAD request it makes at startup.
    for noisy in ("httpx", "httpx2"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    parser = argparse.ArgumentParser(prog="bl")
    sub = parser.add_subparsers(required=True)

    p = sub.add_parser("migrate", help="apply db/migrations and the procrastinate schema")
    p.add_argument("--test-stub", action="store_true", help="apply db/test/auth_stub.sql first")
    p.set_defaults(func=cmd_migrate)

    p = sub.add_parser("worker", help="run jobs and the scan scheduler")
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("--until-idle", action="store_true", help="exit once no job is left")
    p.set_defaults(func=cmd_worker)

    p = sub.add_parser("serve-embed", help="serve POST /embed for search queries")
    p.add_argument("--host", default="127.0.0.1")
    p.set_defaults(func=cmd_serve_embed)

    p = sub.add_parser("scan-local", help="dev: scan a local folder into a lab")
    p.add_argument("lab_id", type=UUID)
    p.add_argument("folder")
    p.set_defaults(func=cmd_scan_local)

    p = sub.add_parser("sample-lab", help="dev: a lab over a sample folder, with its lists")
    p.add_argument("folder")
    p.set_defaults(func=cmd_sample_lab)

    p = sub.add_parser(
        "demo-lab", help="a fake, fully populated lab for an existing user (or --delete it)"
    )
    who = p.add_mutually_exclusive_group(required=True)
    who.add_argument("--admin-email")
    who.add_argument("--admin-user", type=UUID)
    p.add_argument("--delete", action="store_true", help="delete this user's demo lab")
    p.add_argument("--replace", action="store_true", help="delete it first, then build afresh")
    p.add_argument("--no-worker", action="store_true", help="wait for a worker running elsewhere")
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("--timeout", type=int, default=1800, help="seconds to wait for each settle")
    p.set_defaults(func=cmd_demo_lab)

    p = sub.add_parser("relabel", help="run the re-label sweep to the end now, and print its cost")
    p.add_argument("--batch", type=int, default=20)
    p.set_defaults(func=cmd_relabel)

    p = sub.add_parser("eval-labels", help="score stored labels against evals/labels_expected.json")
    p.add_argument("db", help="database URL")
    p.add_argument("--lab", type=UUID)
    p.add_argument(
        "--findability",
        action="store_true",
        help="also run evals/findability.json's searches (loads the embedding model)",
    )
    p.set_defaults(func=cmd_eval_labels)

    args = parser.parse_args(argv)
    args.func(args)
