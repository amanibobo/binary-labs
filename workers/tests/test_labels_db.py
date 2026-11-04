import uuid

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan, search

from bl_worker import samples

LABEL_TABLES = ["experiments", "people", "labels", "corrections", "label_rules"]


def add_label(conn, lab, sha, **fields):
    row = {
        "status": "suggested",
        "clean_name": "P450 batch 3 gel",
        "confidence": 0.9,
        "source": "rules",
        **fields,
    }
    conn.execute(
        "insert into labels (lab_id, sha256, status, clean_name, confidence, source, experiment_id)"
        " values (%s, %s, %s, %s, %s, %s, %s)",
        (
            lab.id,
            sha,
            row["status"],
            row["clean_name"],
            row["confidence"],
            row["source"],
            row.get("experiment_id"),
        ),
    )


def add_experiment(conn, lab, name):
    return conn.execute(
        "insert into experiments (lab_id, name, aliases) values (%s, %s, '{}') returning id",
        (lab.id, name),
    ).fetchone()[0]


@pytest.fixture
def labeled(rt, conn, make_lab):
    """Two labs, each with one indexed file carrying a label, an experiment, a person,
    a correction and a learned rule."""
    labs = []
    for tag in ("alpha", "bravo"):
        lab = make_lab(tag)
        lab.write(f"{tag}/notes_{tag}.txt", f"lysozyme {tag} notes")
        run_scan(rt, lab.source_id)
        (sha,) = conn.execute(
            "select sha256 from file_locations where lab_id = %s", (lab.id,)
        ).fetchone()
        exp = add_experiment(conn, lab, f"Lysozyme {tag}")
        conn.execute(
            "insert into people (lab_id, display_name, aliases) values (%s, %s, '{AB}')",
            (lab.id, f"Person {tag}"),
        )
        add_label(conn, lab, sha, experiment_id=exp)
        with committed_as_user(conn, lab.user_id):
            (cid,) = conn.execute(
                "select correction_id from correct_label(%s, %s, 'renamed', null, %s, null,"
                " null, '{}')",
                (lab.id, sha, exp),
            ).fetchone()
        conn.execute(
            "insert into label_rules (lab_id, kind, folder, experiment_id, correction_id)"
            " values (%s, 'folder_experiment', %s, %s, %s)",
            (lab.id, f"/{tag}", exp, cid),
        )
        labs.append((lab, sha, exp))
    return labs


def test_members_see_their_labs_label_rows_and_none_of_another_labs(conn, labeled):
    (a, _, _), (b, _, _) = labeled
    with as_user(conn, a.user_id):
        for table in LABEL_TABLES:
            mine = conn.execute(f"select count(*) from {table} where lab_id = %s", (a.id,))
            theirs = conn.execute(f"select count(*) from {table} where lab_id = %s", (b.id,))
            assert mine.fetchone()[0] > 0, table
            assert theirs.fetchone() == (0,), table


def test_search_finds_a_file_by_its_label_and_experiment_but_only_in_its_lab(conn, labeled):
    (a, sha_a, _), (b, _, _) = labeled
    with as_user(conn, a.user_id):
        by_name = search(conn, a.id, "renamed", None)
        assert [r["sha256"] for r in by_name] == [sha_a]
        assert by_name[0]["label"]["clean_name"] == "renamed"
        assert by_name[0]["label"]["experiment"]["name"] == "Lysozyme alpha"
        assert [r["sha256"] for r in search(conn, a.id, "Lysozyme alpha", None)] == [sha_a]
        assert search(conn, b.id, "renamed", None) == []


def test_a_member_cannot_write_labels_rules_or_model_calls_directly(conn, labeled):
    (a, sha_a, _), _ = labeled
    statements = [
        ("update labels set clean_name = 'x' where lab_id = %s", (a.id,)),
        (
            "insert into labels (lab_id, sha256, status, clean_name, confidence, source)"
            " values (%s, %s, 'accepted', 'x', 1, 'human')",
            (a.id, sha_a),
        ),
        ("delete from label_rules where lab_id = %s", (a.id,)),
        ("select * from model_calls", ()),
        ("update corrections set after = '{}' where lab_id = %s", (a.id,)),
    ]
    for sql, params in statements:
        with as_user(conn, a.user_id), pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(sql, params)


def test_a_member_cannot_correct_or_add_to_another_lab(conn, labeled):
    (a, _, _), (b, sha_b, _) = labeled
    with as_user(conn, a.user_id), pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(
            "select * from correct_label(%s, %s, 'stolen', null, null, null, null, '{}')",
            (b.id, sha_b),
        )
    with as_user(conn, a.user_id), pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("insert into experiments (lab_id, name) values (%s, 'planted')", (b.id,))
    assert conn.execute("select clean_name from labels where lab_id = %s", (b.id,)).fetchone() == (
        "renamed",
    )


def test_correct_label_records_the_acting_user_and_both_states(conn, labeled, make_lab):
    (a, sha, exp), _ = labeled
    with as_user(conn, a.user_id):
        (cid, label) = conn.execute(
            "select * from correct_label(%s, %s, ' P450 gel ', '2026-10-14', %s, null,"
            " 'ChemiDoc', array['gel', 'gel', ' sds '])",
            (a.id, sha, exp),
        ).fetchone()
        row = conn.execute(
            "select user_id, before, after from corrections where id = %s", (cid,)
        ).fetchone()
    assert row[0] == a.user_id
    assert row[1]["clean_name"] == "renamed" and row[1]["status"] == "corrected"
    assert row[2]["clean_name"] == "P450 gel" and row[2]["status"] == "corrected"
    assert label["date"] == "2026-10-14" and label["tags"] == ["gel", "sds"]
    assert label["instrument"] == "ChemiDoc"


def test_a_correction_cannot_be_logged_as_someone_else(conn, labeled, make_lab):
    (a, sha, _), _ = labeled
    other = uuid.uuid4()
    conn.execute("insert into auth.users (id) values (%s)", (other,))
    with as_user(conn, a.user_id):
        conn.execute(
            "insert into corrections (lab_id, sha256, after) values (%s, %s, %s)",
            (
                a.id,
                sha,
                psycopg.types.json.Jsonb(
                    {
                        "clean_name": "direct",
                        "date": None,
                        "experiment_id": None,
                        "person_id": None,
                        "instrument": None,
                        "tags": [],
                    }
                ),
            ),
        )
        with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
            conn.execute(
                "insert into corrections (lab_id, sha256, user_id, after)"
                " values (%s, %s, %s, '{}')",
                (a.id, sha, other),
            )
        users = conn.execute(
            "select user_id from corrections where lab_id = %s order by id", (a.id,)
        ).fetchall()
    assert users == [(a.user_id,), (a.user_id,)]


def test_accepting_unchanged_values_is_an_acceptance(conn, rt, make_lab):
    lab = make_lab()
    lab.write("x.txt", "x")
    run_scan(rt, lab.source_id)
    (sha,) = conn.execute(
        "select sha256 from file_locations where lab_id = %s", (lab.id,)
    ).fetchone()
    add_label(conn, lab, sha, status="check", confidence=0.6)
    with as_user(conn, lab.user_id):
        _, label = conn.execute(
            "select * from correct_label(%s, %s, 'P450 batch 3 gel', null, null, null, null, '{}')",
            (lab.id, sha),
        ).fetchone()
    assert label["status"] == "accepted" and label["confidence"] == 1


def test_undo_restores_the_exact_prior_state_once(conn, rt, make_lab):
    lab = make_lab()
    lab.write("x.txt", "x")
    run_scan(rt, lab.source_id)
    (sha,) = conn.execute(
        "select sha256 from file_locations where lab_id = %s", (lab.id,)
    ).fetchone()
    add_label(conn, lab, sha, status="check", confidence=0.6)
    before = conn.execute(
        "select label_state(l) from labels l where lab_id = %s", (lab.id,)
    ).fetchone()
    with as_user(conn, lab.user_id):
        (cid, _) = conn.execute(
            "select * from correct_label(%s, %s, 'new name', null, null, null, null, '{}')",
            (lab.id, sha),
        ).fetchone()
        _, label = conn.execute("select * from undo_correction(%s)", (cid,)).fetchone()
        assert label["status"] == "check" and label["clean_name"] == "P450 batch 3 gel"
        with pytest.raises(psycopg.Error, match="already undone") as again:
            conn.execute("select * from undo_correction(%s)", (cid,))
        assert again.value.sqlstate == "BL003"
    assert (
        conn.execute("select label_state(l) from labels l where lab_id = %s", (lab.id,)).fetchone()
        == before
    )


def test_needs_look_queue_lists_unlabeled_files_and_a_name_clears_them(conn, rt, make_lab):
    lab = make_lab()
    lab.write("CD/IMG_5003.jpg", samples.gel_jpeg(seed=1))
    run_scan(rt, lab.source_id)
    (sha,) = conn.execute(
        "select sha256 from file_locations where lab_id = %s", (lab.id,)
    ).fetchone()
    conn.execute(
        "insert into labels (lab_id, sha256, status, confidence, source)"
        " values (%s, %s, 'needs_look', 0.2, 'rules')",
        (lab.id, sha),
    )
    with as_user(conn, lab.user_id):
        rows = conn.execute("select sha256, locations from needs_look_files(%s)", (lab.id,))
        assert [r[0] for r in rows] == [sha]
        assert conn.execute("select needs_look_count(%s)", (lab.id,)).fetchone() == (1,)
        conn.execute(
            "select * from correct_label(%s, %s, 'Lysozyme crystal photo', null, null, null,"
            " null, '{}')",
            (lab.id, sha),
        )
        assert conn.execute("select needs_look_count(%s)", (lab.id,)).fetchone() == (0,)
        status = conn.execute("select status from labels where sha256 = %s", (sha,))
        assert status.fetchone() == ("corrected",)
