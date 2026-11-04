import psycopg
import pytest
from conftest import as_user, run_scan, search

from bl_worker import samples
from bl_worker.embed import HashEmbedder

TABLES = ["file_locations", "chunks", "previews"]


@pytest.fixture
def two_labs(rt, conn, make_lab):
    a, b = make_lab("a"), make_lab("b")
    for lab, tag in ((a, "alpha"), (b, "bravo")):
        lab.write(f"{tag}/gel_{tag}.jpg", samples.gel_jpeg(seed=hash(tag) % 100))
        lab.write(f"{tag}/protocol_{tag}.pdf", samples.pdf([f"P450 gel protocol {tag}"]))
        run_scan(rt, lab.source_id)
    conn.execute("update sources set token_ciphertext = '\\x0102' where id = %s", (b.source_id,))
    return a, b


def test_a_member_sees_none_of_another_labs_rows(conn, two_labs):
    a, b = two_labs
    b_shas = [
        r[0] for r in conn.execute("select sha256 from file_locations where lab_id = %s", (b.id,))
    ]
    q = HashEmbedder().embed_query("P450 gel protocol")
    with as_user(conn, a.user_id):
        for table in TABLES:
            mine = conn.execute(f"select count(*) from {table} where lab_id = %s", (a.id,))
            theirs = conn.execute(f"select count(*) from {table} where lab_id = %s", (b.id,))
            assert mine.fetchone()[0] > 0, table
            assert theirs.fetchone() == (0,), table
        assert conn.execute(
            "select count(*) from blobs where sha256 = any(%s)", (b_shas,)
        ).fetchone() == (0,)
        assert conn.execute("select count(*) from blobs").fetchone()[0] == 2
        assert [r[0] for r in conn.execute("select id from sources")] == [a.source_id]
        assert [r[0] for r in conn.execute("select id from labs")] == [a.id]
        assert len(search(conn, a.id, "P450 gel protocol", q)) == 2
        assert search(conn, b.id, "P450 gel protocol", q) == []


@pytest.mark.parametrize(
    "query",
    [
        "select token_ciphertext from sources",
        "select cursor from sources",
        "select * from extractions",
    ],
)
def test_secrets_and_internal_tables_are_not_readable(conn, two_labs, query):
    a, _ = two_labs
    with as_user(conn, a.user_id), pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(query)


def test_signed_out_requests_see_nothing(conn, two_labs):
    a, _ = two_labs
    with conn.transaction(force_rollback=True):
        conn.execute("set local role authenticated")
        assert conn.execute("select count(*) from file_locations").fetchone() == (0,)
        assert search(conn, a.id, "P450", None) == []
