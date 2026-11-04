import psycopg

from bl_worker.db import migrate


def test_rerun_applies_nothing(database_url):
    assert migrate(database_url, test_stub=True) == []
    with psycopg.connect(database_url) as conn:
        versions = [r[0] for r in conn.execute("select version from schema_migrations order by 1")]
    assert versions == ["0001_core", "0002_search", "procrastinate", "test/auth_stub"]


def test_job_queue_is_closed_to_web_roles(database_url):
    with psycopg.connect(database_url) as conn:
        open_tables = conn.execute(
            """
            select r.rolname, c.relname from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            cross join pg_roles r
            where n.nspname = 'public' and c.relkind = 'r'
              and (c.relname like 'procrastinate%' or c.relname = 'schema_migrations')
              and r.rolname in ('anon', 'authenticated')
              and has_table_privilege(r.oid, c.oid, 'select, insert, update, delete')
            """
        ).fetchall()
        open_functions = conn.execute(
            """
            select r.rolname, p.proname from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join pg_roles r
            where n.nspname = 'public' and p.proname like 'procrastinate%'
              and r.rolname in ('anon', 'authenticated')
              and has_function_privilege(r.oid, p.oid, 'execute')
            """
        ).fetchall()
    assert open_tables == []
    assert open_functions == []
