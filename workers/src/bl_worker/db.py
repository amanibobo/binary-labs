from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

import psycopg
from pgvector.psycopg import register_vector
from procrastinate.schema import SchemaManager

from bl_worker.config import WORKERS_DIR

REPO_DIR = WORKERS_DIR.parent
MIGRATIONS_DIR = REPO_DIR / "db" / "migrations"
AUTH_STUB = REPO_DIR / "db" / "test" / "auth_stub.sql"
MIGRATE_LOCK = 0x626C6D67


def configure(conn: psycopg.Connection) -> None:
    register_vector(conn)


@contextmanager
def connect(url: str) -> Iterator[psycopg.Connection]:
    with psycopg.connect(url) as conn:
        configure(conn)
        yield conn


@dataclass(frozen=True)
class Migration:
    version: str
    sql: str


def pending_migrations(test_stub: bool) -> list[Migration]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    migrations = [Migration(f.stem, f.read_text()) for f in files]
    if test_stub:
        migrations.insert(0, Migration("test/auth_stub", AUTH_STUB.read_text()))
    # Procrastinate's schema.sql is its full current schema, so it goes in once, last,
    # after the app tables it doesn't depend on.
    migrations.append(Migration("procrastinate", SchemaManager.get_schema()))
    return migrations


# Supabase grants new public tables and functions to anon and authenticated, and functions
# to PUBLIC everywhere. Without this, PostgREST would expose the job queue to signed-out
# callers. Re-run on every migrate so it converges.
LOCKDOWN = """
do $$
declare
  r record;
  grantees text := 'public';
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grantees := grantees || ', anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grantees := grantees || ', authenticated';
  end if;
  for r in
    select c.oid::regclass as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'S')
      and (c.relname like 'procrastinate%' or c.relname = 'schema_migrations')
  loop
    execute format('revoke all on %s from %s', r.rel, grantees);
    if (select relkind from pg_class where oid = r.rel) <> 'S' then
      execute format('alter table %s enable row level security', r.rel);
    end if;
  end loop;
  for r in
    select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'procrastinate%'
  loop
    execute format('revoke all on function %s from %s', r.fn, grantees);
  end loop;
end
$$;
"""


def migrate(url: str, *, test_stub: bool) -> list[str]:
    """Applies what's missing, each file in its own transaction; returns the versions applied."""
    applied_now: list[str] = []
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("select pg_advisory_lock(%s)", (MIGRATE_LOCK,))
        try:
            conn.execute(
                "create table if not exists schema_migrations ("
                " version text primary key, applied_at timestamptz not null default now())"
            )
            done = {row[0] for row in conn.execute("select version from schema_migrations")}
            for m in pending_migrations(test_stub):
                if m.version in done:
                    continue
                with conn.transaction():
                    conn.execute(m.sql.encode())
                    conn.execute(
                        "insert into schema_migrations (version) values (%s)", (m.version,)
                    )
                applied_now.append(m.version)
            conn.execute(LOCKDOWN.encode())
        finally:
            conn.execute("select pg_advisory_unlock(%s)", (MIGRATE_LOCK,))
    return applied_now
