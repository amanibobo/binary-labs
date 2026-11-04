import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import psycopg
import pytest
from botocore.stub import Stubber
from conftest import KEY, as_user, committed_as_user, run_scan
from procrastinate import PsycopgConnector
from psycopg.types.json import Jsonb

from bl_worker import deletion, process, samples, scan
from bl_worker.crypto import encrypt_token
from bl_worker.db import lab_lock
from bl_worker.domain import Entry, ListPage, SourceKind
from bl_worker.jobs import app, due_sources
from bl_worker.labels import job as labels
from bl_worker.previews import LocalPreviewStore, R2PreviewStore, lab_prefix
from bl_worker.sources import SOURCE_FACTORIES

SHARED = "Shared/buffer recipe.txt", "Tris 50 mM, NaCl 300 mM, the buffer both labs use"


def raises_code(code):
    return pytest.raises(psycopg.Error, check=lambda e: e.sqlstate == code)


def add_member(conn, lab_id, role="member"):
    user_id = uuid.uuid4()
    conn.execute("insert into auth.users (id) values (%s)", (user_id,))
    conn.execute(
        "insert into members (lab_id, user_id, role) values (%s, %s, %s)", (lab_id, user_id, role)
    )
    return user_id


def add_dropbox(conn, lab_id, root="/Lab"):
    (source_id,) = conn.execute(
        "insert into sources (lab_id, kind, root_path, account_label, token_ciphertext, cursor)"
        " values (%s, 'dropbox', %s, 'pi@lab.edu', %s, 'c1') returning id",
        (lab_id, root, encrypt_token(KEY, "refresh-token")),
    ).fetchone()
    return source_id


def request_deletion(conn, lab, name):
    with committed_as_user(conn, lab.user_id):
        conn.execute("select request_lab_deletion(%s, %s)", (lab.id, name))


def everything_in(rt, conn, lab, tag):
    """Fills a lab with one of each kind of row: files with previews and labels, a protocol,
    a correction, a model call, an experiment and a Dropbox source."""
    lab.write(f"Gels/{tag}_gel.jpg", samples.gel_jpeg(seed=sum(map(ord, tag))))
    lab.write(f"Notes/{tag}.txt", f"Notes only {tag} has: lysis at 4 C")
    lab.write(*SHARED)
    run_scan(rt, lab.source_id)
    shas = [
        r[0] for r in conn.execute("select sha256 from file_locations where lab_id = %s", (lab.id,))
    ]
    for sha in shas:
        labels.label_blob(rt, lab.id, sha)
    conn.execute(
        "insert into model_calls (lab_id, sha256, purpose, model, prompt_version, output,"
        " input_tokens, output_tokens, cost_usd) values (%s, %s, 'label', 'm', 1, %s, 1, 1, 0)",
        (lab.id, shas[0], Jsonb({"text": "{}"})),
    )
    with committed_as_user(conn, lab.user_id):
        conn.execute("insert into experiments (lab_id, name) values (%s, 'P450')", (lab.id,))
        conn.execute(
            "select create_protocol(%s, 'protocol', %s, 'Thaw on ice.', null, %s)",
            (lab.id, f"Lysis {tag}", shas[0]),
        )
        conn.execute(
            "select correct_label(%s, %s, %s, null, null, null, null, '{}')",
            (lab.id, shas[0], f"Renamed {tag}"),
        )
    add_dropbox(conn, lab.id)
    return shas


@pytest.fixture
def labs(rt, conn, make_lab):
    a, b = make_lab("alpha"), make_lab("bravo")
    return a, everything_in(rt, conn, a, "alpha"), b, everything_in(rt, conn, b, "bravo")


def blob_of(conn, lab, name):
    return conn.execute(
        "select sha256 from file_locations where lab_id = %s and original_name = %s",
        (lab.id, name),
    ).fetchone()[0]


def rows_mentioning(conn, needle):
    """Every row in every table of ours (and auth) whose text contains the needle."""
    tables = conn.execute(
        "select quote_ident(n.nspname) || '.' || quote_ident(c.relname) from pg_class c"
        " join pg_namespace n on n.oid = c.relnamespace"
        " where c.relkind in ('r', 'p') and n.nspname in ('public', 'auth')"
    ).fetchall()
    found = {}
    for (table,) in tables:
        (n,) = conn.execute(
            f"select count(*) from {table} t where t::text like %s", (f"%{needle}%",)
        ).fetchone()
        if n:
            found[table] = n
    return found


def test_lab_tables_and_blob_references_match_the_schema(conn):
    with_lab = {
        r[0]
        for r in conn.execute(
            "select table_name from information_schema.columns"
            " where table_schema = 'public' and column_name = 'lab_id'"
        )
    }
    assert with_lab - {"lab_deletions"} == set(deletion.LAB_TABLES), (
        "a table with lab_id goes in deletion.LAB_TABLES, so deletion counts it"
    )
    pointing = {
        r[0]
        for r in conn.execute(
            "select conrelid::regclass::text from pg_constraint"
            " where contype = 'f' and confrelid = 'blobs'::regclass"
        )
    }
    assert pointing - {"extractions"} == set(deletion.BLOB_REFERENCES), (
        "a table pointing at blobs goes in deletion.BLOB_REFERENCES, or a blob it uses is deleted"
    )


def test_only_an_admin_who_types_the_name_can_delete_or_disconnect(conn, make_lab):
    lab, outsider_lab = make_lab("Okafor Lab"), make_lab("other")
    member = add_member(conn, lab.id)
    source = add_dropbox(conn, lab.id)
    with as_user(conn, member):
        with raises_code("42501"), conn.transaction():
            conn.execute("select request_lab_deletion(%s, 'Okafor Lab')", (lab.id,))
        with raises_code("42501"), conn.transaction():
            conn.execute("select disconnect_source(%s)", (source,))
        conn.execute("update labs set deletion_requested_at = now() where id = %s", (lab.id,))
        conn.execute("update sources set token_ciphertext = null where id = %s", (source,))
    with as_user(conn, outsider_lab.user_id):
        with raises_code("BL202"), conn.transaction():
            conn.execute("select request_lab_deletion(%s, 'Okafor Lab')", (lab.id,))
        with raises_code("BL203"), conn.transaction():
            conn.execute("select disconnect_source(%s)", (source,))
    with as_user(conn, lab.user_id), raises_code("BL201"):
        conn.execute("select request_lab_deletion(%s, 'okafor lab')", (lab.id,))
    assert conn.execute(
        "select deletion_requested_at from labs where id = %s", (lab.id,)
    ).fetchone() == (None,)
    assert conn.execute(
        "select token_ciphertext is not null, disconnected_at from sources where id = %s",
        (source,),
    ).fetchone() == (True, None)
    assert conn.execute("select count(*) from lab_deletions").fetchone() == (0,)


def test_a_request_hides_the_lab_from_every_member_at_once(rt, conn, labs):
    a, a_shas, b, _ = labs
    member = add_member(conn, a.id)
    request_deletion(conn, a, " alpha ")

    for user in (a.user_id, member):
        with as_user(conn, user):
            readable = [
                t
                for t in deletion.LAB_TABLES
                if conn.execute("select has_any_column_privilege(%s, 'select')", (t,)).fetchone()[0]
            ]
            assert len(readable) >= 12
            for table in readable:
                count = conn.execute(f"select count(*) from {table} where lab_id = %s", (a.id,))
                assert count.fetchone() == (0,), table
            assert conn.execute("select count(*) from labs").fetchone() == (0,)
            assert conn.execute("select count(*) from members").fetchone() == (0,)
            assert conn.execute(
                "select count(*) from blobs where sha256 = any(%s)", (a_shas,)
            ).fetchone() == (0,)
            assert conn.execute("select * from search_files(%s, 'lysis')", (a.id,)).fetchall() == []
            assert conn.execute("select * from protocol_list(%s)", (a.id,)).fetchall() == []
            assert conn.execute(
                "select is_lab_member(%s), is_lab_admin(%s)", (a.id, a.id)
            ).fetchone() == (False, False)
            with raises_code("42501"), conn.transaction():
                conn.execute("select create_protocol(%s, 'protocol', 'new', '')", (a.id,))
    with as_user(conn, b.user_id):
        assert len(conn.execute("select * from search_files(%s, 'lysis')", (b.id,)).fetchall()) > 0

    sources = conn.execute(
        "select kind, token_ciphertext is null, disconnected_at is not null, scan_requested_at"
        " from sources where lab_id = %s order by kind",
        (a.id,),
    ).fetchall()
    assert sources == [("dropbox", True, True, None), ("local", True, False, None)]
    deletion_row = conn.execute(
        "select requested_by, completed_at from lab_deletions where lab_id = %s", (a.id,)
    ).fetchone()
    assert deletion_row == (a.user_id, None)
    with as_user(conn, a.user_id):
        assert conn.execute("select lab_id from lab_deletions").fetchall() == [(a.id,)]
    with as_user(conn, member):
        assert conn.execute("select lab_id from lab_deletions").fetchall() == []
    with as_user(conn, a.user_id), raises_code("BL202"):
        conn.execute("select request_lab_deletion(%s, 'alpha')", (a.id,))


def test_the_job_leaves_nothing_of_the_lab_but_the_deletion_record(rt, conn, labs):
    a, a_shas, b, _ = labs
    shared = blob_of(conn, a, "buffer recipe.txt")
    assert shared == blob_of(conn, b, "buffer recipe.txt")
    only_a = [s for s in a_shas if s != shared]
    previews = rt.settings.preview_dir
    assert list((previews / lab_prefix(a.id)).iterdir())
    b_files = sorted(p.name for p in (previews / lab_prefix(b.id)).iterdir())

    def lab_b_state():
        return [
            conn.execute(f"select count(*) from {t} where lab_id = %s", (b.id,)).fetchone()[0]
            for t in deletion.LAB_TABLES
        ]

    b_before = lab_b_state()
    conn.execute(
        "insert into procrastinate_jobs (queue_name, task_name, args, status)"
        " values ('default', 'label_blob', %s, 'failed')",
        (Jsonb({"lab_id": str(a.id), "sha256": only_a[0]}),),
    )
    request_deletion(conn, a, "alpha")

    counts = deletion.delete_lab(rt, a.id)

    assert counts is not None
    assert counts["file_locations"] == 3 and counts["protocols"] == 1 and counts["corrections"] == 1
    assert counts["blobs"] == len(only_a) and counts["extractions"] == len(only_a)
    assert counts["preview_files"] == 1 and counts["jobs"] == 1
    assert rows_mentioning(conn, str(a.id)) == {"public.lab_deletions": 1}
    for sha in only_a:
        assert rows_mentioning(conn, sha) == {}, sha
    assert not (previews / lab_prefix(a.id)).exists()
    record = conn.execute(
        "select completed_at is not null, counts from lab_deletions where lab_id = %s", (a.id,)
    ).fetchone()
    assert record == (True, counts)

    assert lab_b_state() == b_before
    assert sorted(p.name for p in (previews / lab_prefix(b.id)).iterdir()) == b_files
    assert conn.execute(
        "select count(*) from extractions where sha256 = %s", (shared,)
    ).fetchone() == (1,)
    with as_user(conn, b.user_id):
        hits = conn.execute(
            "select sha256 from search_files(%s, 'buffer recipe')", (b.id,)
        ).fetchall()
        assert (shared,) in hits
        assert (
            conn.execute("select file_text(%s, %s)", (b.id, shared))
            .fetchone()[0]
            .startswith("Tris")
        )

    assert deletion.delete_lab(rt, a.id) is None
    assert conn.execute(
        "select counts from lab_deletions where lab_id = %s", (a.id,)
    ).fetchone() == (counts,)
    assert lab_b_state() == b_before


def test_a_run_that_dies_after_the_previews_finishes_on_the_next(rt, conn, labs, monkeypatch):
    a, _, _, _ = labs
    request_deletion(conn, a, "alpha")

    def dies(conn, lab_id):
        raise RuntimeError("worker died")

    with monkeypatch.context() as m:
        m.setattr(deletion, "_delete_rows", dies)
        with pytest.raises(RuntimeError):
            deletion.delete_lab(rt, a.id)
    assert not (rt.settings.preview_dir / lab_prefix(a.id)).exists()
    assert conn.execute("select count(*) from labs where id = %s", (a.id,)).fetchone() == (1,)

    counts = deletion.delete_lab(rt, a.id)
    assert counts is not None and counts["preview_files"] == 0 and counts["file_locations"] == 3
    assert rows_mentioning(conn, str(a.id)) == {"public.lab_deletions": 1}


def test_a_file_being_processed_finishes_before_the_deletion_starts(rt, conn, make_lab):
    lab = make_lab()
    lab.write("gel.jpg", samples.gel_jpeg(seed=1))
    with rt.pool.connection() as c:
        (loc,) = scan.scan_source(c, rt.settings, lab.source_id)

    with ThreadPoolExecutor(1) as pool:
        with rt.pool.connection() as deleter, lab_lock(deleter, lab.id, exclusive=True):
            processing = pool.submit(process.process_location, rt, loc)
            time.sleep(0.5)
            assert not processing.done(), "processing waits while a deletion holds the lab"
            request_deletion(conn, lab, "lab")
        assert processing.result(timeout=10) == process.Outcome.SKIPPED
    assert conn.execute("select count(*) from blobs").fetchone() == (0,)
    assert not (rt.settings.preview_dir / lab_prefix(lab.id)).exists()


def test_the_scheduler_never_scans_a_deleted_or_disconnected_source(rt, conn, make_lab):
    deleted, disconnected, live = make_lab("deleted"), make_lab("disconnected"), make_lab("live")
    dropbox = add_dropbox(conn, disconnected.id)
    conn.execute("update sources set scan_requested_at = now()")
    with committed_as_user(conn, disconnected.user_id):
        conn.execute("select disconnect_source(%s)", (dropbox,))
    conn.execute("update sources set scan_requested_at = now()")
    request_deletion(conn, deleted, "deleted")
    conn.execute("update sources set scan_requested_at = now()")

    assert sorted(due_sources(conn)) == sorted([live.source_id, disconnected.source_id])
    deleted.write("a.txt", "never read")
    with rt.pool.connection() as c:
        assert scan.scan_source(c, rt.settings, deleted.source_id) == []
        assert scan.scan_source(c, rt.settings, dropbox) == []
    assert conn.execute(
        "select count(*) from file_locations where source_id = any(%s)",
        ([deleted.source_id, dropbox],),
    ).fetchone() == (0,)


class TwoPages:
    """A Dropbox listing whose admin disconnects between its first and second page."""

    def __init__(self, rt, source_id):
        self.rt, self.source_id, self.calls = rt, source_id, 0

    def list(self, cursor):
        self.calls += 1
        if self.calls == 2:
            with self.rt.pool.connection() as c:
                c.execute(
                    "update sources set token_ciphertext = null where id = %s", (self.source_id,)
                )
        entry = Entry(
            f"id:{self.calls}",
            f"/Lab/f{self.calls}.txt",
            f"f{self.calls}.txt",
            1,
            datetime.now(UTC),
            "h",
        )
        return ListPage(
            entries=[entry], deleted=[], next_cursor=f"c{self.calls}", has_more=self.calls < 2
        )

    def read(self, external_id):
        raise AssertionError("nothing is read from a disconnected source")


def test_a_disconnect_mid_scan_stops_it_before_the_next_page(rt, conn, make_lab, monkeypatch):
    lab = make_lab()
    source = add_dropbox(conn, lab.id)
    fake = TwoPages(rt, source)
    monkeypatch.setitem(SOURCE_FACTORIES, SourceKind.DROPBOX, lambda row, settings: fake)
    with rt.pool.connection() as c:
        assert scan.scan_source(c, rt.settings, source) == []
    assert conn.execute(
        "select path from file_locations where source_id = %s", (source,)
    ).fetchall() == [("/Lab/f1.txt",)]
    assert conn.execute(
        "select cursor, scan_error, disconnected_at is not null from sources where id = %s",
        (source,),
    ).fetchone() == (None, None, True)
    (loc,) = conn.execute(
        "select id from file_locations where source_id = %s", (source,)
    ).fetchone()
    assert process.process_location(rt, loc) == process.Outcome.SKIPPED


def test_disconnect_keeps_the_index_and_connecting_again_lists_afresh(rt, conn, make_lab):
    lab = make_lab()
    member = add_member(conn, lab.id)
    lab.write("notes.txt", "lysis at 4 C")
    run_scan(rt, lab.source_id)
    conn.execute(
        "update file_locations set source_id = %s where lab_id = %s",
        (add_dropbox(conn, lab.id), lab.id),
    )
    (source,) = conn.execute(
        "select id from sources where lab_id = %s and kind = 'dropbox'", (lab.id,)
    ).fetchone()

    with committed_as_user(conn, lab.user_id):
        conn.execute("select disconnect_source(%s)", (source,))
        conn.execute("select disconnect_source(%s)", (source,))
    state = conn.execute(
        "select token_ciphertext, cursor, scan_requested_at, disconnected_at is not null"
        " from sources where id = %s",
        (source,),
    ).fetchone()
    assert state == (None, None, None, True)
    actions = conn.execute(
        "select action::text, actor from audit_log"
        " where lab_id = %s and action = 'source.disconnect'",
        (lab.id,),
    ).fetchall()
    assert actions == [("source.disconnect", lab.user_id)]
    with as_user(conn, member):
        assert (
            len(conn.execute("select * from search_files(%s, 'lysis')", (lab.id,)).fetchall()) == 1
        )
        assert conn.execute(
            "select disconnected_at is not null from sources where id = %s", (source,)
        ).fetchone() == (True,)

    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "update sources set token_ciphertext = %s, account_label = 'new@lab.edu' where id = %s",
            (encrypt_token(KEY, "new-refresh-token"), source),
        )
    state = conn.execute(
        "select cursor, scan_requested_at is not null, disconnected_at from sources where id = %s",
        (source,),
    ).fetchone()
    assert state == (None, True, None)
    assert source in due_sources(conn)


def test_the_sweep_queues_and_finishes_a_requested_deletion(rt, conn, make_lab, database_url):
    lab = make_lab()
    lab.write("notes.txt", "lysis at 4 C")
    run_scan(rt, lab.source_id)
    request_deletion(conn, lab, "lab")
    with app.replace_connector(PsycopgConnector(conninfo=database_url)) as a, a.open():
        a.configure_task("sweep_deletions").defer(timestamp=0)
        a.run_worker(wait=False, install_signal_handlers=False, additional_context={"runtime": rt})
    assert conn.execute(
        "select completed_at is not null, counts ->> 'file_locations' from lab_deletions"
    ).fetchall() == [(True, "1")]
    assert conn.execute("select count(*) from labs where id = %s", (lab.id,)).fetchone() == (0,)


def test_local_preview_store_deletes_one_labs_prefix(tmp_path):
    store = LocalPreviewStore(tmp_path)
    a, b = uuid.uuid4(), uuid.uuid4()
    store.put(f"{a}/1.webp", b"x")
    store.put(f"{a}/2.webp", b"y")
    store.put(f"{b}/1.webp", b"z")
    assert store.delete_prefix(lab_prefix(a)) == 2
    assert store.delete_prefix(lab_prefix(a)) == 0
    assert store.get(f"{b}/1.webp") == b"z"


def test_r2_preview_store_deletes_every_page_under_the_prefix():
    store = R2PreviewStore("acct", "key", "secret", "bucket")
    stub = Stubber(store._s3)
    page = [{"Key": f"lab/{i}.webp"} for i in range(1000)]
    stub.add_response(
        "list_objects_v2",
        {"Contents": page, "IsTruncated": True, "NextContinuationToken": "t"},
        {"Bucket": "bucket", "Prefix": "lab/"},
    )
    stub.add_response(
        "delete_objects", {}, {"Bucket": "bucket", "Delete": {"Objects": page, "Quiet": True}}
    )
    stub.add_response(
        "list_objects_v2",
        {"Contents": [{"Key": "lab/last.webp"}], "IsTruncated": False},
        {"Bucket": "bucket", "Prefix": "lab/", "ContinuationToken": "t"},
    )
    stub.add_response(
        "delete_objects",
        {},
        {"Bucket": "bucket", "Delete": {"Objects": [{"Key": "lab/last.webp"}], "Quiet": True}},
    )
    with stub:
        assert store.delete_prefix("lab/") == 1001
    stub.assert_no_pending_responses()
