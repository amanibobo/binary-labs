from __future__ import annotations

import argparse
import logging
from pathlib import Path
from uuid import UUID

from bl_worker.config import load_settings


def cmd_migrate(args: argparse.Namespace) -> None:
    from bl_worker.db import migrate

    applied = migrate(load_settings().database_url, test_stub=args.test_stub)
    print("applied: " + (", ".join(applied) if applied else "nothing, up to date"))


def cmd_worker(args: argparse.Namespace) -> None:
    from procrastinate import PsycopgConnector

    from bl_worker.jobs import app
    from bl_worker.runtime import build_runtime

    settings = load_settings()
    rt = build_runtime(settings, pool_size=args.concurrency + 2)
    try:
        with app.replace_connector(PsycopgConnector(conninfo=settings.database_url)):
            app.run_worker(
                concurrency=args.concurrency,
                additional_context={"runtime": rt},
                delete_jobs="successful",
            )
    finally:
        rt.close()


def cmd_serve_embed(args: argparse.Namespace) -> None:
    import uvicorn

    from bl_worker.embed import build_embedder
    from bl_worker.embed_api import create_app

    settings = load_settings()
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


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(prog="bl")
    sub = parser.add_subparsers(required=True)

    p = sub.add_parser("migrate", help="apply db/migrations and the procrastinate schema")
    p.add_argument("--test-stub", action="store_true", help="apply db/test/auth_stub.sql first")
    p.set_defaults(func=cmd_migrate)

    p = sub.add_parser("worker", help="run jobs and the scan scheduler")
    p.add_argument("--concurrency", type=int, default=4)
    p.set_defaults(func=cmd_worker)

    p = sub.add_parser("serve-embed", help="serve POST /embed for search queries")
    p.add_argument("--host", default="127.0.0.1")
    p.set_defaults(func=cmd_serve_embed)

    p = sub.add_parser("scan-local", help="dev: scan a local folder into a lab")
    p.add_argument("lab_id", type=UUID)
    p.add_argument("folder")
    p.set_defaults(func=cmd_scan_local)

    args = parser.parse_args(argv)
    args.func(args)
