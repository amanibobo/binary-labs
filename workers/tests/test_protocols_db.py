import uuid

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan

PROTOCOL_TABLES = ["protocols", "protocol_versions", "protocol_files"]
BODY = "1. Thaw the pellet on ice.\n2. Spin the lysate at 15000 g for 30 min."


def create(conn, lab_id, title="P450 purification", body=BODY, kind="protocol", sha=None):
    return conn.execute(
        "select * from create_protocol(%s, %s, %s, %s, null, %s)", (lab_id, kind, title, body, sha)
    ).fetchone()


def save(conn, protocol_id, base_id, title="P450 purification", body=BODY, note=None):
    return conn.execute(
        "select * from save_protocol(%s, %s, %s, %s, %s)", (protocol_id, base_id, title, body, note)
    ).fetchone()


def add_member(conn, lab_id, role="member"):
    user_id = uuid.uuid4()
    conn.execute("insert into auth.users (id) values (%s)", (user_id,))
    conn.execute(
        "insert into members (lab_id, user_id, role) values (%s, %s, %s)", (lab_id, user_id, role)
    )
    return user_id


def raises_code(code):
    return pytest.raises(psycopg.Error, check=lambda e: e.sqlstate == code)


@pytest.fixture
def two_labs(rt, conn, make_lab):
    """Two labs, each with one indexed text file and a protocol linking it."""
    labs = []
    for tag in ("alpha", "bravo"):
        lab = make_lab(tag)
        lab.write(f"Protocols/lysis_{tag}.txt", f"Lysis buffer for {tag}: 50 mM Tris, 300 mM NaCl")
        run_scan(rt, lab.source_id)
        (sha,) = conn.execute(
            "select sha256 from file_locations where lab_id = %s", (lab.id,)
        ).fetchone()
        with committed_as_user(conn, lab.user_id):
            protocol_id, version_id, _ = create(conn, lab.id, title=f"Lysis {tag}", sha=sha)
        labs.append((lab, sha, protocol_id, version_id))
    return labs


def test_members_see_their_labs_pages_and_none_of_another_labs(conn, two_labs):
    (a, _, pa, _), (b, sha_b, pb, _) = two_labs
    with as_user(conn, a.user_id):
        for table in PROTOCOL_TABLES:
            mine = conn.execute(f"select count(*) from {table} where lab_id = %s", (a.id,))
            theirs = conn.execute(f"select count(*) from {table} where lab_id = %s", (b.id,))
            assert mine.fetchone()[0] > 0, table
            assert theirs.fetchone() == (0,), table
        assert [r[0] for r in conn.execute("select id from protocol_list(%s)", (a.id,))] == [pa]
        assert conn.execute("select * from protocol_list(%s)", (b.id,)).fetchall() == []
        assert conn.execute("select * from protocol_version(%s)", (pb,)).fetchall() == []
        assert conn.execute("select * from search_protocols(%s, 'lysis')", (b.id,)).fetchall() == []
        assert conn.execute("select file_text(%s, %s)", (b.id, sha_b)).fetchone() == (None,)
        assert conn.execute("select file_text(%s, %s)", (a.id, sha_b)).fetchone() == (None,)
        assert conn.execute("select * from file_hits(%s, %s)", (b.id, [sha_b])).fetchall() == []


def test_a_member_cannot_write_to_another_labs_pages(conn, two_labs):
    (a, sha_a, _, _), (b, sha_b, pb, vb) = two_labs
    with as_user(conn, a.user_id):
        with raises_code("42501"), conn.transaction():
            create(conn, b.id)
        with raises_code("BL103"), conn.transaction():
            save(conn, pb, vb, title="stolen")
        with raises_code("BL103"), conn.transaction():
            conn.execute("select link_protocol_file(%s, %s)", (pb, sha_a))
        conn.execute("select unlink_protocol_file(%s, %s)", (pb, sha_b))
        with raises_code("42501"), conn.transaction():
            conn.execute(
                "insert into protocol_versions (protocol_id, lab_id, based_on, title, body)"
                " values (%s, %s, %s, 'planted', '')",
                (pb, b.id, vb),
            )
    assert conn.execute(
        "select count(*) from protocol_versions where lab_id = %s", (b.id,)
    ).fetchone() == (1,)
    assert conn.execute(
        "select count(*) from protocol_files where lab_id = %s", (b.id,)
    ).fetchone() == (1,)


def test_saves_make_numbered_versions_and_a_stale_base_is_rejected(conn, two_labs):
    (a, _, pa, v1), _ = two_labs
    other = add_member(conn, a.id)
    with committed_as_user(conn, a.user_id):
        _, v2, n2 = save(conn, pa, v1, body=BODY + "\n3. Load the column.", note=" added step 3 ")
        assert n2 == 2
        with raises_code("BL101"), conn.transaction():
            save(conn, pa, v1, body="an edit started from version 1")
        _, v3, n3 = save(conn, pa, v2, title="  P450 purification, v3 ")
        assert n3 == 3
        current = conn.execute(
            "select version_id, version, title, current_version from protocol_version(%s)", (pa,)
        ).fetchone()
        assert current == (v3, 3, "P450 purification, v3", 3)
        old = conn.execute(
            "select version_id, note, author, current_version from protocol_version(%s, 2)", (pa,)
        ).fetchone()
        assert old == (v2, "added step 3", a.user_id, 3)
    with as_user(conn, other):
        _, _, n4 = save(conn, pa, v3, body="edited by another member")
        assert n4 == 4
        author = conn.execute("select author from protocol_version(%s)", (pa,)).fetchone()
        assert author == (other,)


def test_versions_are_immutable_and_only_triggers_move_the_current_one(conn, two_labs):
    (a, _, pa, v1), _ = two_labs
    statements = [
        ("update protocol_versions set body = 'rewritten' where id = %s", (v1,)),
        ("delete from protocol_versions where id = %s", (v1,)),
        ("update protocols set current_version_id = %s where id = %s", (v1, pa)),
        ("delete from protocols where id = %s", (pa,)),
        (
            "insert into protocol_versions (protocol_id, lab_id, based_on, title, body, author)"
            " values (%s, %s, %s, 't', '', %s)",
            (pa, a.id, v1, a.user_id),
        ),
        (
            "insert into protocol_versions (protocol_id, lab_id, based_on, title, body, version)"
            " values (%s, %s, %s, 't', '', 9)",
            (pa, a.id, v1),
        ),
    ]
    for sql, params in statements:
        with as_user(conn, a.user_id), pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(sql, params)
    assert conn.execute("select body from protocol_versions where id = %s", (v1,)).fetchone() == (
        BODY,
    )


def test_a_member_cannot_archive_and_an_admin_can(conn, two_labs):
    (a, sha_a, pa, v1), _ = two_labs
    member = add_member(conn, a.id)
    with as_user(conn, member):
        with raises_code("42501"), conn.transaction():
            conn.execute("select archive_protocol(%s)", (pa,))
        updated = conn.execute(
            "update protocols set archived_at = now() where id = %s", (pa,)
        ).rowcount
        assert updated == 0
    assert conn.execute("select archived_at from protocols where id = %s", (pa,)).fetchone() == (
        None,
    )

    with committed_as_user(conn, a.user_id):
        conn.execute("select archive_protocol(%s)", (pa,))
    with as_user(conn, member):
        assert conn.execute("select * from protocol_list(%s)", (a.id,)).fetchall() == []
        assert conn.execute("select * from search_protocols(%s, 'lysis')", (a.id,)).fetchall() == []
        with raises_code("BL102"), conn.transaction():
            save(conn, pa, v1)
        with raises_code("BL102"), conn.transaction():
            conn.execute("select link_protocol_file(%s, %s)", (pa, sha_a))
        kept = conn.execute(
            "select version, archived_at is not null from protocol_version(%s)", (pa,)
        )
        assert kept.fetchone() == (1, True)
    with as_user(conn, a.user_id), raises_code("BL102"):
        conn.execute("update protocols set archived_at = null where id = %s", (pa,))


def test_create_save_archive_and_links_are_audited(conn, two_labs):
    (a, sha_a, pa, v1), _ = two_labs
    with committed_as_user(conn, a.user_id):
        save(conn, pa, v1)
        conn.execute("select unlink_protocol_file(%s, %s)", (pa, sha_a))
        conn.execute("select link_protocol_file(%s, %s)", (pa, sha_a))
        conn.execute("select link_protocol_file(%s, %s)", (pa, sha_a))
        conn.execute("select archive_protocol(%s)", (pa,))
    rows = conn.execute(
        "select action::text, actor, target from audit_log"
        " where lab_id = %s and action::text like 'protocol.%%' order by id",
        (a.id,),
    ).fetchall()
    assert [r[0] for r in rows] == [
        "protocol.create",
        "protocol.link_file",
        "protocol.save",
        "protocol.unlink_file",
        "protocol.link_file",
        "protocol.archive",
    ]
    assert {r[1] for r in rows} == {a.user_id}
    assert rows[0][2] == str(pa) and rows[1][2] == f"{pa} {sha_a}"


def test_a_page_starts_from_a_files_text_and_links_only_this_labs_files(conn, two_labs):
    (a, sha_a, pa, _), (_, sha_b, _, _) = two_labs
    with as_user(conn, a.user_id):
        text = conn.execute("select file_text(%s, %s)", (a.id, sha_a)).fetchone()[0]
        assert text == "Lysis buffer for alpha: 50 mM Tris, 300 mM NaCl"
        hits = conn.execute("select sha256, locations from file_hits(%s, %s)", (a.id, [sha_a]))
        (hit,) = hits.fetchall()
        assert hit[0] == sha_a and hit[1][0]["path"].endswith("Protocols/lysis_alpha.txt")
        linked = conn.execute(
            "select sha256, ord from protocol_files where protocol_id = %s", (pa,)
        )
        assert linked.fetchall() == [(sha_a, 1)]
        with raises_code("BL104"), conn.transaction():
            conn.execute("select link_protocol_file(%s, %s)", (pa, sha_b))


def test_search_finds_current_titles_and_bodies_only(conn, two_labs):
    (a, _, pa, v1), _ = two_labs
    with as_user(conn, a.user_id):
        tutorial, _, _ = create(
            conn,
            a.id,
            title="Using the ChemiDoc",
            body="Open the lid and image the gel.",
            kind="tutorial",
        )
        assert [
            r[0] for r in conn.execute("select id from search_protocols(%s, 'chemidoc')", (a.id,))
        ] == [tutorial]
        by_body = conn.execute(
            "select id, kind, snippet from search_protocols(%s, 'lysate')", (a.id,)
        )
        (row,) = by_body.fetchall()
        assert row[0] == pa and row[1] == "protocol" and "lysate" in row[2]
        save(conn, pa, v1, body="No lysis step here any more.")
        assert (
            conn.execute("select * from search_protocols(%s, 'lysate')", (a.id,)).fetchall() == []
        )
        both = conn.execute("select id from search_protocols(%s, 'lysis gel')", (a.id,)).fetchall()
        assert {r[0] for r in both} == {pa, tutorial}


def test_deleting_a_lab_takes_its_pages_with_it(conn, two_labs):
    (a, _, pa, v1), (b, _, _, _) = two_labs
    with committed_as_user(conn, a.user_id):
        save(conn, pa, v1)
    conn.execute("delete from labs where id = %s", (a.id,))
    for table in PROTOCOL_TABLES:
        assert conn.execute(
            f"select count(*) from {table} where lab_id = %s", (a.id,)
        ).fetchone() == (0,)
        assert (
            conn.execute(f"select count(*) from {table} where lab_id = %s", (b.id,)).fetchone()[0]
            > 0
        )
