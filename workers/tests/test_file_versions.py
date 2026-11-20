import os

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan

from bl_worker import deletion, originals, samples
from bl_worker.previews import file_key
from bl_worker.process import Outcome


def edit(lab, rel: str, text: str, at: int) -> None:
    """Writes the file with its own mtime, so the local source sees a new revision."""
    path = lab.write(rel, text)
    os.utime(path, ns=(at * 1_000_000_000, at * 1_000_000_000))


def versions(conn, lab_id, path: str) -> list[tuple[int, str, int, str]]:
    return conn.execute(
        "select fv.number, fv.sha256, fv.size, fv.original_name from file_versions fv"
        " join file_locations fl on fl.id = fv.location_id"
        " where fv.lab_id = %s and fl.path = %s order by fv.number",
        (lab_id, path),
    ).fetchall()


def test_each_edit_is_a_version_and_reading_the_same_content_again_is_not(rt, conn, make_lab):
    lab = make_lab()
    edit(lab, "AB/buffers/tris.txt", "Tris-HCl pH 8.0", 1_700_000_000)
    assert run_scan(rt, lab.source_id) == [Outcome.INDEXED]
    first = versions(conn, lab.id, "/AB/buffers/tris.txt")
    assert [(n, size) for n, _, size, _ in first] == [(1, 15)]

    assert run_scan(rt, lab.source_id) == []
    conn.execute("update file_locations set index_state = 'pending' where lab_id = %s", (lab.id,))
    assert run_scan(rt, lab.source_id) == [Outcome.INDEXED]
    assert versions(conn, lab.id, "/AB/buffers/tris.txt") == first

    edit(lab, "AB/buffers/tris.txt", "Tris-HCl pH 7.5, 150 mM NaCl", 1_700_000_100)
    assert run_scan(rt, lab.source_id) == [Outcome.INDEXED]
    edit(lab, "AB/buffers/tris.txt", "Tris-HCl pH 8.0", 1_700_000_200)
    assert run_scan(rt, lab.source_id) == [Outcome.INDEXED]

    got = versions(conn, lab.id, "/AB/buffers/tris.txt")
    assert [n for n, *_ in got] == [1, 2, 3]
    # Changed back to what it was: a third version with the first one's content.
    assert got[2][1] == got[0][1] != got[1][1]
    assert got[1][2] == 28
    current = conn.execute(
        "select sha256 from file_locations where lab_id = %s", (lab.id,)
    ).fetchone()
    assert current == (got[2][1],)
    saved = conn.execute(
        "select extract(epoch from modified_at)::bigint from file_versions"
        " where lab_id = %s order by number",
        (lab.id,),
    ).fetchall()
    assert saved == [(1_700_000_000,), (1_700_000_100,), (1_700_000_200,)]


def test_the_drive_shows_one_row_per_content_with_its_version_count(rt, conn, make_lab):
    lab = make_lab()
    edit(lab, "AB/buffers/tris.txt", "Tris-HCl pH 8.0", 1_700_000_000)
    lab.write("CD/plates/plate.csv", samples.csv_text([["Well", "OD600"], ["A1", 0.4]]))
    run_scan(rt, lab.source_id)
    edit(lab, "AB/buffers/tris.txt", "Tris-HCl pH 7.5", 1_700_000_100)
    # A copy of the edited file elsewhere: one row, standing at the place with the history.
    edit(lab, "CD/old/tris copy.txt", "Tris-HCl pH 7.5", 1_700_000_050)
    run_scan(rt, lab.source_id)

    with as_user(conn, lab.user_id):
        folders = conn.execute(
            "select key, name, files, edited from drive_folders(%s, 'experiment')", (lab.id,)
        ).fetchall()
        assert folders == [("", None, 2, 1)]
        rows = conn.execute(
            "select locations -> 0 ->> 'path', versions, jsonb_array_length(locations)"
            " from drive_files(%s, 'experiment', '')",
            (lab.id,),
        ).fetchall()
        assert rows == [("/CD/plates/plate.csv", 1, 1), ("/AB/buffers/tris.txt", 2, 2)]
        months = conn.execute("select key, files from drive_folders(%s, 'month')", (lab.id,))
        assert sum(n for _, n in months) == 2
        nonsense = conn.execute("select * from drive_folders(%s, 'nonsense')", (lab.id,))
        assert nonsense.fetchall() == []


def test_a_persons_name_for_a_file_follows_it_to_the_next_version(rt, conn, make_lab):
    lab = make_lab()
    edit(lab, "named.txt", "first", 1_700_000_000)
    edit(lab, "guessed.txt", "uno", 1_700_000_000)
    run_scan(rt, lab.source_id)
    (experiment,) = conn.execute(
        "insert into experiments (lab_id, name) values (%s, 'P450 batch 3') returning id", (lab.id,)
    ).fetchone()
    for path, status, name in (
        ("/named.txt", "corrected", "Tris buffer recipe"),
        ("/guessed.txt", "suggested", "A guess"),
    ):
        conn.execute(
            "insert into labels (lab_id, sha256, status, clean_name, experiment_id, confidence,"
            " source, summary, prompt_version)"
            " select lab_id, sha256, %s, %s, %s, 0.9, 'human', 'About the first content', 2"
            " from file_locations where lab_id = %s and path = %s",
            (status, name, experiment, lab.id, path),
        )
    edit(lab, "named.txt", "second", 1_700_000_100)
    edit(lab, "guessed.txt", "dos", 1_700_000_100)
    run_scan(rt, lab.source_id)

    labels = conn.execute(
        "select fl.path, l.status, l.clean_name, l.experiment_id, l.summary, l.prompt_version"
        " from file_locations fl"
        " left join labels l on l.lab_id = fl.lab_id and l.sha256 = fl.sha256"
        " where fl.lab_id = %s order by fl.path",
        (lab.id,),
    ).fetchall()
    # The summary described the old content, so it isn't carried; the label job writes a new one.
    assert labels == [
        ("/guessed.txt", None, None, None, None, None),
        ("/named.txt", "corrected", "Tris buffer recipe", experiment, None, None),
    ]
    with as_user(conn, lab.user_id):
        folder = conn.execute(
            "select name, files, edited from drive_folders(%s, 'experiment') where key = %s",
            (lab.id, str(experiment)),
        ).fetchall()
        assert folder == [("P450 batch 3", 1, 1)]


def test_history_is_the_labs_own_and_goes_from_view_with_the_file(rt, conn, make_lab):
    lab, other = make_lab("a"), make_lab("b")
    edit(lab, "notes.txt", "pellet thawed on ice", 1_700_000_000)
    run_scan(rt, lab.source_id)
    edit(lab, "notes.txt", "pellet thawed on ice\nspun 10 min", 1_700_000_100)
    run_scan(rt, lab.source_id)
    (location,) = conn.execute(
        "select id from file_locations where lab_id = %s", (lab.id,)
    ).fetchone()
    old_id, old_sha = conn.execute(
        "select id, sha256 from file_versions where location_id = %s and number = 1", (location,)
    ).fetchone()
    blob_count = "select count(*) from blobs where sha256 = %s"

    with as_user(conn, lab.user_id):
        history = conn.execute(
            "select number, original_name, source_kind, who, file_kind from file_history(%s, %s)",
            (lab.id, location),
        ).fetchall()
        assert history == [
            (1, "notes.txt", "local", None, "text"),
            (2, "notes.txt", "local", None, "text"),
        ]
        # The old content has no live location of its own, and is still readable as a version.
        assert conn.execute(blob_count, (old_sha,)).fetchone() == (1,)
        text = conn.execute("select version_text(%s, %s)", (lab.id, old_id)).fetchone()
        assert text == ("pellet thawed on ice",)
    with as_user(conn, other.user_id):
        assert conn.execute("select count(*) from file_versions").fetchone() == (0,)
        theirs = conn.execute("select * from file_history(%s, %s)", (lab.id, location))
        assert theirs.fetchall() == []
        assert conn.execute("select version_text(%s, %s)", (lab.id, old_id)).fetchone() == (None,)
        assert conn.execute(blob_count, (old_sha,)).fetchone() == (0,)

    (lab.folder / "notes.txt").unlink()
    run_scan(rt, lab.source_id)
    with as_user(conn, lab.user_id):
        gone = conn.execute("select * from file_history(%s, %s)", (lab.id, location))
        assert gone.fetchall() == []
        assert conn.execute("select version_text(%s, %s)", (lab.id, old_id)).fetchone() == (None,)
        assert conn.execute(blob_count, (old_sha,)).fetchone() == (0,)
        folders = conn.execute("select * from drive_folders(%s, 'experiment')", (lab.id,))
        assert folders.fetchall() == []


@pytest.mark.parametrize(
    "sql",
    [
        "update file_versions set number = 9 where lab_id = %s",
        "delete from file_versions where lab_id = %s",
    ],
)
def test_a_member_cannot_write_history(rt, conn, make_lab, sql):
    lab = make_lab()
    edit(lab, "notes.txt", "one", 1_700_000_000)
    run_scan(rt, lab.source_id)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), as_user(conn, lab.user_id):
        conn.execute(sql, (lab.id,))


def test_deleting_the_lab_takes_its_history_and_the_old_contents(rt, conn, make_lab):
    lab = make_lab()
    edit(lab, "notes.txt", "one", 1_700_000_000)
    run_scan(rt, lab.source_id)
    edit(lab, "notes.txt", "two", 1_700_000_100)
    run_scan(rt, lab.source_id)
    assert conn.execute("select count(*) from blobs").fetchone() == (2,)

    with committed_as_user(conn, lab.user_id):
        conn.execute("select request_lab_deletion(%s, 'lab')", (lab.id,))
    counts = deletion.delete_lab(rt, lab.id)

    assert counts is not None and counts["file_versions"] == 2 and counts["blobs"] == 2
    assert conn.execute("select count(*) from blobs").fetchone() == (0,)
    assert conn.execute("select count(*) from file_versions").fetchone() == (0,)


def kept(conn, lab_id) -> list[tuple[int, bool]]:
    return conn.execute(
        "select number, kept_at is not null from file_versions where lab_id = %s order by number",
        (lab_id,),
    ).fetchall()


def test_every_version_keeps_its_own_bytes_unchanged(rt, conn, make_lab):
    lab = make_lab()
    first = samples.gel_jpeg(seed=7)
    second = samples.gel_jpeg(seed=8)
    path = lab.write("gel.jpg", first)
    os.utime(path, ns=(1_700_000_000 * 10**9, 1_700_000_000 * 10**9))
    run_scan(rt, lab.source_id)
    path.write_bytes(second)
    os.utime(path, ns=(1_700_000_100 * 10**9, 1_700_000_100 * 10**9))
    run_scan(rt, lab.source_id)

    shas = [sha for _, sha, _, _ in versions(conn, lab.id, "/gel.jpg")]
    assert kept(conn, lab.id) == [(1, True), (2, True)]
    # The source now holds only the second; the first is still ours, byte for byte.
    assert rt.previews.get(file_key(lab.id, shas[0])) == first
    assert rt.previews.get(file_key(lab.id, shas[1])) == second
    assert path.read_bytes() == second
    with as_user(conn, lab.user_id):
        assert conn.execute("select * from lab_originals(%s)", (lab.id,)).fetchone() == (
            2,
            len(first) + len(second),
            0,
            0,
        )
        history = conn.execute(
            "select number, kept from file_history(%s, (select id from file_locations"
            " where lab_id = %s))",
            (lab.id, lab.id),
        ).fetchall()
        assert history == [(1, True), (2, True)]


def test_a_copy_and_a_change_back_share_one_stored_object(rt, conn, make_lab, monkeypatch):
    lab = make_lab()
    edit(lab, "a.txt", "one", 1_700_000_000)
    edit(lab, "copy of a.txt", "one", 1_700_000_000)
    puts: list[str] = []
    put = rt.previews.put
    monkeypatch.setattr(
        rt.previews, "put", lambda key, data, *a, **k: (puts.append(key), put(key, data, *a, **k))
    )
    run_scan(rt, lab.source_id)
    edit(lab, "a.txt", "two", 1_700_000_100)
    run_scan(rt, lab.source_id)
    edit(lab, "a.txt", "one", 1_700_000_200)
    run_scan(rt, lab.source_id)

    files = [k for k in puts if "/files/" in k]
    assert len(files) == 2 and len(set(files)) == 2
    assert all(k for _, k in kept(conn, lab.id))
    assert conn.execute(
        "select kept_files, waiting_files from lab_originals(%s)", (lab.id,)
    ).fetchone() == (2, 0)


def test_files_read_before_originals_were_kept_are_read_again_and_kept(rt, conn, make_lab):
    lab = make_lab()
    edit(lab, "old.txt", "read long ago", 1_700_000_000)
    edit(lab, "edited.txt", "as it was", 1_700_000_000)
    run_scan(rt, lab.source_id)
    # As the migration leaves a lab: versions recorded, nothing in the store.
    conn.execute("update file_versions set kept_at = null where lab_id = %s", (lab.id,))
    rt.previews.delete_prefix(f"{lab.id}/files/")
    # One of them changes on disk before the sweep reaches it; no scan has seen that yet.
    (lab.folder / "edited.txt").write_text("as it is now")

    todo = originals.waiting(conn)
    assert len(todo) == 2
    outcomes = sorted(originals.keep_location(rt, loc) for loc in todo)
    assert outcomes == [originals.Kept.CHANGED, originals.Kept.KEPT]
    state = dict(
        conn.execute(
            "select fv.original_name, fv.kept_at is not null from file_versions fv"
            " where fv.lab_id = %s",
            (lab.id,),
        ).fetchall()
    )
    assert state == {"old.txt": True, "edited.txt": False}
    (sha,) = conn.execute(
        "select sha256 from file_locations where lab_id = %s and path = '/old.txt'", (lab.id,)
    ).fetchone()
    assert rt.previews.get(file_key(lab.id, sha)) == b"read long ago"
    # A second pass does nothing more: one is kept, the other still doesn't match.
    again = sorted(originals.keep_location(rt, loc) for loc in todo)
    assert again == [originals.Kept.CHANGED, originals.Kept.SKIPPED]

    # The next scan records the edit as version 2 and keeps it; version 1's bytes are gone
    # from the source for good, and the history says so rather than pretending.
    run_scan(rt, lab.source_id)
    edited = conn.execute(
        "select fv.number, fv.kept_at is not null from file_versions fv"
        " join file_locations fl on fl.id = fv.location_id"
        " where fl.path = '/edited.txt' order by fv.number"
    ).fetchall()
    assert edited == [(1, False), (2, True)]
    assert originals.waiting(conn) == []


def test_deleting_the_lab_removes_the_kept_originals(rt, conn, make_lab):
    lab = make_lab()
    edit(lab, "notes.txt", "one", 1_700_000_000)
    run_scan(rt, lab.source_id)
    (sha,) = conn.execute(
        "select sha256 from file_versions where lab_id = %s", (lab.id,)
    ).fetchone()
    assert rt.previews.get(file_key(lab.id, sha)) == b"one"

    with committed_as_user(conn, lab.user_id):
        conn.execute("select request_lab_deletion(%s, 'lab')", (lab.id,))
    deletion.delete_lab(rt, lab.id)

    assert rt.previews.get(file_key(lab.id, sha)) is None
    assert (lab.folder / "notes.txt").read_text() == "one"
