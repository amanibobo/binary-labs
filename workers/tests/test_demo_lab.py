"""bl demo-lab: one demo lab per admin, built through the app's own functions, idempotent,
never touching another lab, and deleted the way the app deletes a lab."""

import hashlib
import uuid

import pytest
from conftest import committed_as_user, run_scan

from bl_worker import data_tables, deletion, demo_content, demo_lab, talk_throughs, videos
from bl_worker.jobs import due_sources
from bl_worker.labels import job as labels
from bl_worker.previews import file_key, lab_prefix


def drain(rt, lab, files_only):
    """What the worker would do for the lab, synchronously, until nothing is left."""
    for _ in range(4):
        with rt.pool.connection() as conn:
            # Only sources asked for, as the worker's schedule_scans does.
            ours = {r[0] for r in conn.execute("select id from sources where lab_id = %s", (lab,))}
            due = [s for s in due_sources(conn) if s in ours]
        for source in due:
            run_scan(rt, source)
        with rt.pool.connection() as conn:
            todo = labels.unlabeled(conn, models=False)
            unlabeled = [sha for lab_id, sha in todo if lab_id == lab]
            tables = [sha for lab_id, sha in data_tables.waiting(conn) if lab_id == lab]
            linked = [sha for lab_id, sha in videos.waiting(conn) if lab_id == lab]
            drafts = talk_throughs.waiting_for_steps(conn)
        for sha in unlabeled:
            labels.label_blob(rt, lab, sha)
        for sha in tables:
            data_tables.parse_waiting(rt, lab, sha)
        for sha in linked:
            videos.transcribe_video(rt, lab, sha)
        for talk_through in drafts:
            talk_throughs.draft_steps(rt, talk_through)
        with rt.pool.connection() as conn:
            if not demo_lab.unsettled(conn, lab, files_only=files_only):
                return
    with rt.pool.connection() as conn:
        raise AssertionError(demo_lab.unsettled(conn, lab, files_only=files_only))


def make_user(conn, email):
    user = uuid.uuid4()
    conn.execute("insert into auth.users (id, email) values (%s, %s)", (user, email))
    return user


def snapshot(conn, labs):
    """Every lab row of these labs, hashed per table, so any change shows."""
    out = {}
    for table in deletion.LAB_TABLES:
        (out[table],) = conn.execute(
            "select count(*) || ':'"
            f" || coalesce(md5(string_agg(t::text, ',' order by t::text)), '')"
            f" from {table} t where lab_id = any(%s)",
            (labs,),
        ).fetchone()
    return out


def stored(rt, lab):
    root = rt.settings.preview_dir / lab_prefix(lab)
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())


@pytest.fixture
def other_lab(rt, conn):
    """Someone else's lab with an uploaded file, and the admin's own real lab, both named like
    the demo so only labs.plan tells them apart."""

    def make(admin):
        other = make_user(conn, "other@x.edu")
        labs = []
        for user in (other, admin):
            with committed_as_user(conn, user):
                (lab,) = conn.execute("select create_lab(%s)", (demo_content.LAB_NAME,)).fetchone()
            data = f"bench notes {lab}".encode()
            sha = hashlib.sha256(data).hexdigest()
            rt.previews.put(file_key(lab, sha), data)
            with committed_as_user(conn, user):
                conn.execute(
                    "select * from record_upload(%s, %s, %s, 'notes.txt', 'P450 BM3',"
                    " current_date, null)",
                    (lab, sha, len(data)),
                )
            labs.append(lab)
        for lab in labs:
            drain(rt, lab, False)
        return labs

    return make


def test_the_demo_lab_is_full_and_a_second_run_changes_nothing(rt, conn):
    admin = make_user(conn, "a.okafor@university.edu")
    lab = demo_lab.build(rt, admin, lambda lab, files_only: drain(rt, lab, files_only))

    counts = dict(
        conn.execute(
            "select s.kind::text, count(*) from file_locations fl"
            " join sources s on s.id = fl.source_id"
            " where fl.lab_id = %s and fl.index_state <> 'pending' group by 1",
            (lab,),
        ).fetchall()
    )
    assert counts == {"import": 70, "instrument": 4, "upload": 5}
    assert conn.execute(
        "select count(*), count(*) filter (where index_state = 'indexed')"
        " from file_locations where lab_id = %s and source_id in"
        " (select id from sources where kind = 'import')",
        (lab,),
    ).fetchone() == (70, 69)  # instrument/legacy_export.pdf is truncated and fails
    assert conn.execute("select count(*) from protocols where lab_id = %s", (lab,)).fetchone() == (
        len(demo_content.PROTOCOLS),
    )
    assert conn.execute(
        "select count(*) from protocol_files where lab_id = %s", (lab,)
    ).fetchone() == (sum(len(p.files) for p in demo_content.PROTOCOLS) + 1,)  # and the video
    assert conn.execute(
        "select count(*) from charts where lab_id = %s and created_by = %s", (lab, admin)
    ).fetchone() == (len(demo_content.CHARTS),)
    assert (
        conn.execute(
            "select count(*) from labels where lab_id = %s and status = 'needs_look'", (lab,)
        ).fetchone()[0]
        > 0
    )
    assert conn.execute(
        "select bool_and(i.instrument = %s) from labels i join file_locations fl"
        " on fl.lab_id = i.lab_id and fl.sha256 = i.sha256 join instruments ins"
        " on ins.source_id = fl.source_id where i.lab_id = %s",
        (demo_content.INSTRUMENT, lab),
    ).fetchone() == (True,)
    assert conn.execute(
        "select min(uploaded_on), max(uploaded_on), bool_and(uploaded_by = %s)"
        " from uploads where lab_id = %s",
        (admin, lab),
    ).fetchone()[2]

    before, files = snapshot(conn, [lab]), stored(rt, lab)
    again = demo_lab.build(rt, admin, lambda lab, files_only: drain(rt, lab, files_only))
    assert again == lab
    assert snapshot(conn, [lab]) == before
    assert stored(rt, lab) == files
    assert demo_lab.demo_labs(conn, admin) == [lab]


def test_building_and_deleting_the_demo_never_touches_another_lab(rt, conn, other_lab):
    admin = make_user(conn, "a.okafor@university.edu")
    others = other_lab(admin)
    before = snapshot(conn, others)
    files = {lab: stored(rt, lab) for lab in others}
    assert demo_lab.demo_labs(conn, admin) == []

    lab = demo_lab.build(rt, admin, lambda lab, files_only: drain(rt, lab, files_only))
    assert lab not in others
    assert demo_lab.demo_labs(conn, admin) == [lab]
    assert snapshot(conn, others) == before

    assert demo_lab.delete(rt, admin) == [lab]
    assert snapshot(conn, others) == before
    assert {lab: stored(rt, lab) for lab in others} == files
    assert conn.execute(
        "select count(*) from labs where id = any(%s) and deletion_requested_at is null", (others,)
    ).fetchone() == (2,)


def test_delete_goes_through_the_apps_lab_deletion(rt, conn):
    admin = make_user(conn, "a.okafor@university.edu")
    assert demo_lab.delete(rt, admin) == []
    lab = demo_lab.build(rt, admin, lambda lab, files_only: drain(rt, lab, files_only))
    assert stored(rt, lab)

    assert demo_lab.delete(rt, admin) == [lab]
    requested_by, completed, counts = conn.execute(
        "select requested_by, completed_at, counts from lab_deletions where lab_id = %s", (lab,)
    ).fetchone()
    assert requested_by == admin and completed is not None and counts["file_locations"] == 79
    assert conn.execute("select count(*) from labs where id = %s", (lab,)).fetchone() == (0,)
    assert stored(rt, lab) == []
    assert demo_lab.delete(rt, admin) == []


def test_a_missing_user_is_an_error(conn):
    with pytest.raises(demo_lab.DemoError):
        demo_lab.find_admin(conn, email="nobody@x.edu", user_id=None)
