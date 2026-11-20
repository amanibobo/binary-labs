from conftest import committed_as_user, run_scan
from psycopg.types.json import Jsonb

from bl_worker import task_exports
from bl_worker.jobs import app


def shared_run(conn, lab, sha, title):
    """A failed run with an attested cause, shared, in a lab that agreed."""
    with committed_as_user(conn, lab.user_id):
        (run,) = conn.execute(
            "select (create_run(%s, %s, %s) ->> 'id')::uuid",
            (lab.id, [sha], Jsonb({"title": title, "status": "failed"})),
        ).fetchone()
    (person,) = conn.execute(
        "insert into people (lab_id, display_name) values (%s, %s) returning id",
        (lab.id, f"PI of {title}"),
    ).fetchone()
    conn.execute(
        "update runs set confirmed_cause = 'old buffer', confirmed_by = %s,"
        " confirm_method = 'control', confirmed_at = now(), confirmer_attested_at = now(),"
        " share = true where id = %s",
        (person, run),
    )
    conn.execute(
        "update labs set sharing_agreed_at = now(), sharing_agreement = 'v1' where id = %s",
        (lab.id,),
    )
    return run


def built_folder(rt, conn, lab, run, prefix=None):
    """A folder recorded for the run, with its two files in the store."""
    (grant,) = conn.execute(
        "insert into run_log (lab_id, run_id, via, action) values (%s, %s, 'person',"
        " 'export.allowed') returning id",
        (lab.id, run),
    ).fetchone()
    (export,) = conn.execute(
        "insert into task_exports (lab_id, run_id, grant_id, purpose) values (%s, %s, %s, 'task')"
        " returning id",
        (lab.id, run, grant),
    ).fetchone()
    place = prefix or f"{lab.id}/exports/{export}"
    conn.execute("update task_exports set storage_prefix = %s where id = %s", (place, export))
    rt.previews.put(f"{place}/task.zip", b"zip", "application/zip")
    rt.previews.put(f"{place}/manifest.json", b"{}", "application/json")
    return export, place


def prefix_of(conn, export):
    return conn.execute(
        "select storage_prefix from task_exports where id = %s", (export,)
    ).fetchone()[0]


def test_withdrawn_folders_lose_their_files_and_standing_ones_keep_them(rt, conn, make_lab):
    lab = make_lab("alpha")
    lab.write("a.csv", "well,od\nA1,0.4\n")
    lab.write("b.csv", "well,od\nA1,0.5\n")
    run_scan(rt, lab.source_id)
    shas = [
        r[0]
        for r in conn.execute(
            "select sha256 from file_locations where lab_id = %s order by path", (lab.id,)
        )
    ]
    gone_run = shared_run(conn, lab, shas[0], "Withdrawn")
    kept_run = shared_run(conn, lab, shas[1], "Standing")
    gone, gone_at = built_folder(rt, conn, lab, gone_run)
    kept, kept_at = built_folder(rt, conn, lab, kept_run)
    original = f"{lab.id}/files/{shas[0]}"
    rt.previews.put(original, b"the run's own file", "text/csv")

    assert task_exports.remove_withdrawn(rt) == 0
    assert rt.previews.get(f"{gone_at}/task.zip") == b"zip"

    # Sharing goes off; 0034's trigger withdraws the folder.
    conn.execute("update runs set share = false where id = %s", (gone_run,))
    assert task_exports.remove_withdrawn(rt) == 1
    assert rt.previews.get(f"{gone_at}/task.zip") is None
    assert rt.previews.get(f"{gone_at}/manifest.json") is None
    assert prefix_of(conn, gone) is None
    assert rt.previews.get(f"{kept_at}/task.zip") == b"zip"
    assert prefix_of(conn, kept) == kept_at
    assert rt.previews.get(original) == b"the run's own file"
    assert task_exports.remove_withdrawn(rt) == 0


def test_a_sweep_that_died_after_deleting_finishes_next_time(rt, conn, make_lab):
    lab = make_lab("bravo")
    lab.write("a.csv", "well,od\nA1,0.4\n")
    run_scan(rt, lab.source_id)
    (sha,) = conn.execute(
        "select sha256 from file_locations where lab_id = %s", (lab.id,)
    ).fetchone()
    run = shared_run(conn, lab, sha, "Half done")
    export, place = built_folder(rt, conn, lab, run)
    conn.execute("update runs set share = false where id = %s", (run,))
    rt.previews.delete_prefix(f"{place}/")
    assert prefix_of(conn, export) == place
    assert task_exports.remove_withdrawn(rt) == 1
    assert prefix_of(conn, export) is None


def test_a_row_that_names_another_place_deletes_nothing(rt, conn, make_lab):
    lab = make_lab("charlie")
    lab.write("a.csv", "well,od\nA1,0.4\n")
    run_scan(rt, lab.source_id)
    (sha,) = conn.execute(
        "select sha256 from file_locations where lab_id = %s", (lab.id,)
    ).fetchone()
    run = shared_run(conn, lab, sha, "Odd prefix")
    export, place = built_folder(rt, conn, lab, run, prefix=f"{lab.id}/files")
    conn.execute("update runs set share = false where id = %s", (run,))
    assert task_exports.remove_withdrawn(rt) == 0
    assert rt.previews.get(f"{place}/task.zip") == b"zip"
    assert prefix_of(conn, export) == place


def test_the_sweep_is_a_periodic_job():
    assert "sweep_withdrawn_folders" in app.tasks
    assert any(
        p.task.name == "sweep_withdrawn_folders"
        for p in app.periodic_registry.periodic_tasks.values()
    )
