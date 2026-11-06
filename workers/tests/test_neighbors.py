import os
import uuid

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan

from bl_worker import deletion, neighbors, samples

# Three files about one Ni-NTA run, two about plate reads, one that is neither. The hash
# embedder makes texts close when they share words, so the groups are what similar means here.
NI_NTA = (
    "Ni-NTA purification of His-tagged P450 BM3. Equilibrate the HisTrap column with lysis"
    " buffer, load the clarified lysate, wash with imidazole and elute with an imidazole"
    " gradient. Pool the red fractions and dialyse overnight."
)
PLATE = (
    "Plate reader absorbance at 420 nm for wells A1 to H12, read every minute for an hour,"
    " blank subtracted with buffer only wells, kinetic mode at 25 C."
)
OTHER = "Group meeting agenda: travel reimbursements, conference posters and the holiday party."


def sha_of(conn, lab, name):
    return conn.execute(
        "select sha256 from file_locations where lab_id = %s and original_name = %s",
        (lab.id, name),
    ).fetchone()[0]


def lists(conn, lab):
    """Each file's list by name, nearest first."""
    rows = conn.execute(
        "select a.original_name, b.original_name, n.similarity from file_neighbors n"
        " join file_locations a on a.lab_id = n.lab_id and a.sha256 = n.sha256"
        " join file_locations b on b.lab_id = n.lab_id and b.sha256 = n.neighbor"
        " where n.lab_id = %s order by 1, 3 desc, 2",
        (lab.id,),
    ).fetchall()
    out: dict[str, list[str]] = {}
    for a, b, _ in rows:
        out.setdefault(a, []).append(b)
    return out


def settle(conn, lab):
    """Ages the chunk change times past the settle delay, as waiting would."""
    conn.execute(
        "update file_vectors set chunks_changed_at = chunks_changed_at - interval '1 minute'"
        " where lab_id = %s",
        (lab.id,),
    )


@pytest.fixture
def lab(rt, conn, make_lab):
    lab = make_lab("map")
    lab.write("P450/nickel run 1.txt", NI_NTA)
    lab.write("P450/nickel run 2.txt", NI_NTA + " Second run, fresh column.")
    lab.write("P450/nickel run 3.txt", NI_NTA.replace("overnight", "for four hours"))
    lab.write("Plates/plate 7.txt", PLATE)
    lab.write("Plates/plate 8.txt", PLATE.replace("420", "405"))
    lab.write("Admin/agenda.txt", OTHER)
    lab.write("Gels/gel.jpg", samples.gel_jpeg(seed=3))
    run_scan(rt, lab.source_id)
    settle(conn, lab)
    return lab


def vectors(conn, lab):
    return dict(
        conn.execute(
            "select fl.original_name, v.embedding is not null from file_vectors v"
            " join file_locations fl on fl.lab_id = v.lab_id and fl.sha256 = v.sha256"
            " where v.lab_id = %s"
            " and (v.computed_at is null or v.computed_at >= v.chunks_changed_at)",
            (lab.id,),
        ).fetchall()
    )


def test_content_chunks_mark_a_vector_and_a_photo_waits_for_its_caption(rt, conn, lab):
    stale = conn.execute(
        "select count(*) from file_vectors where lab_id = %s and computed_at is null", (lab.id,)
    ).fetchone()
    # Every file with text below its name chunk, the photo's EXIF included.
    assert stale == (7,)
    assert neighbors.stale_labs(conn) == [lab.id]

    neighbors.refresh_lab(rt, lab.id)

    found = vectors(conn, lab)
    assert found.pop("gel.jpg") is False
    assert len(found) == 6 and all(found.values())
    assert "gel.jpg" not in lists(conn, lab)


def test_similar_files_list_each_other_and_unrelated_files_list_nothing(rt, conn, lab):
    done = neighbors.refresh_lab(rt, lab.id)

    assert done.vectors == 7 and done.moved == 6
    found = lists(conn, lab)
    assert set(found["nickel run 1.txt"]) == {"nickel run 2.txt", "nickel run 3.txt"}
    assert set(found["plate 7.txt"]) == {"plate 8.txt"}
    assert "agenda.txt" not in found
    assert all("agenda.txt" not in v for v in found.values())
    sims = conn.execute(
        "select min(similarity), max(similarity), max(n) from"
        " (select similarity, count(*) over (partition by sha256) as n from file_neighbors"
        " where lab_id = %s) x",
        (lab.id,),
    ).fetchone()
    assert sims[0] >= neighbors.MIN_SIMILARITY["hash-1024"] and sims[1] <= 1
    assert sims[2] <= neighbors.K
    assert neighbors.stale_labs(conn) == []
    # Nothing stale, nothing to do; a second pass changes nothing.
    again = neighbors.refresh_lab(rt, lab.id)
    assert (again.vectors, again.lists) == (0, 0)
    assert lists(conn, lab) == found


def test_a_file_that_changes_leaves_old_lists_and_enters_new_ones(rt, conn, lab):
    neighbors.refresh_lab(rt, lab.id)
    # nickel run 3 is rewritten as a plate read; a rescan rewrites its chunks.
    lab.write("P450/nickel run 3.txt", PLATE + " Read again after the column.")
    run_scan(rt, lab.source_id)
    settle(conn, lab)
    assert neighbors.stale_labs(conn) == [lab.id]

    done = neighbors.refresh_lab(rt, lab.id)

    assert done.moved == 1 and done.lists >= 3
    found = lists(conn, lab)
    assert set(found["nickel run 1.txt"]) == {"nickel run 2.txt"}
    assert "nickel run 3.txt" in found["plate 7.txt"]
    assert set(found["nickel run 3.txt"]) == {"plate 7.txt", "plate 8.txt"}


def test_a_rescan_with_the_same_text_redoes_no_list(rt, conn, lab):
    neighbors.refresh_lab(rt, lab.id)
    for path in lab.folder.rglob("*.txt"):
        st = path.stat()
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
    run_scan(rt, lab.source_id)
    settle(conn, lab)
    assert neighbors.stale_labs(conn) == [lab.id]

    done = neighbors.refresh_lab(rt, lab.id)

    assert done.vectors == 6 and done.moved == 0 and done.lists == 0


def test_a_file_whose_chunks_are_still_embedding_waits(rt, conn, lab):
    sha = sha_of(conn, lab, "plate 8.txt")
    conn.execute(
        "update chunks set embedding = null, embed_model = null"
        " where lab_id = %s and sha256 = %s and ord = 1",
        (lab.id, sha),
    )
    settle(conn, lab)

    neighbors.refresh_lab(rt, lab.id)

    assert conn.execute(
        "select computed_at is null or computed_at < chunks_changed_at from file_vectors"
        " where lab_id = %s and sha256 = %s",
        (lab.id, sha),
    ).fetchone() == (True,)
    assert "plate 8.txt" not in lists(conn, lab)


def test_a_deleted_file_is_no_one_s_neighbor(rt, conn, lab):
    conn.execute(
        "update file_locations set deleted_at = now()"
        " where lab_id = %s and original_name = 'nickel run 2.txt'",
        (lab.id,),
    )

    neighbors.refresh_lab(rt, lab.id)

    found = lists(conn, lab)
    assert set(found["nickel run 1.txt"]) == {"nickel run 3.txt"}


def test_lists_stay_in_their_lab_and_members_see_only_their_own(rt, conn, lab, make_lab):
    other = make_lab("other")
    other.write("Same/nickel run 1.txt", NI_NTA)
    other.write("Same/nickel run 2.txt", NI_NTA + " Second run, fresh column.")
    run_scan(rt, other.source_id)
    settle(conn, other)
    neighbors.refresh_lab(rt, lab.id)
    neighbors.refresh_lab(rt, other.id)

    assert set(lists(conn, other)) == {"nickel run 1.txt", "nickel run 2.txt"}
    assert (
        conn.execute(
            "select count(*) from file_neighbors n join file_neighbors m on m.sha256 = n.sha256"
            " and m.lab_id <> n.lab_id where n.lab_id = %s",
            (lab.id,),
        ).fetchone()[0]
        > 0
    )
    with as_user(conn, other.user_id):
        assert conn.execute(
            "select count(*) from file_neighbors where lab_id = %s", (lab.id,)
        ).fetchone() == (0,)
        assert (
            conn.execute("select count(*) from file_neighbors").fetchone()[0]
            == conn.execute(
                "select count(*) from file_neighbors where lab_id = %s", (other.id,)
            ).fetchone()[0]
        )
        with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
            conn.execute("select count(*) from file_vectors")
        with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
            conn.execute(
                "insert into file_neighbors (lab_id, sha256, neighbor, similarity)"
                " values (%s, 'a', 'b', 1)",
                (other.id,),
            )
    stranger = uuid.uuid4()
    conn.execute("insert into auth.users (id) values (%s)", (stranger,))
    with as_user(conn, stranger):
        assert conn.execute("select count(*) from file_neighbors").fetchone() == (0,)


def test_deleting_the_lab_takes_its_vectors_and_lists(rt, conn, lab):
    neighbors.refresh_lab(rt, lab.id)
    assert (
        conn.execute("select count(*) from file_neighbors where lab_id = %s", (lab.id,)).fetchone()[
            0
        ]
        > 0
    )
    with committed_as_user(conn, lab.user_id):
        conn.execute("select request_lab_deletion(%s, 'map')", (lab.id,))

    counts = deletion.delete_lab(rt, lab.id)

    assert counts is not None and counts["file_vectors"] == 7 and counts["file_neighbors"] > 0
    for table in ("file_vectors", "file_neighbors"):
        assert conn.execute(
            f"select count(*) from {table} where lab_id = %s", (lab.id,)
        ).fetchone() == (0,)


def test_lists_a_stopped_job_left_undone_are_redone_next_time(rt, conn, lab):
    neighbors.refresh_lab(rt, lab.id)
    before = lists(conn, lab)
    # As if the job stopped after the vectors and before the lists.
    conn.execute("delete from file_neighbors where lab_id = %s", (lab.id,))
    conn.execute("update file_vectors set listed_at = null where lab_id = %s", (lab.id,))
    assert neighbors.stale_labs(conn) == [lab.id]

    done = neighbors.refresh_lab(rt, lab.id)

    assert done.vectors == 0 and lists(conn, lab) == before
    assert neighbors.stale_labs(conn) == []


def test_a_model_with_no_floor_is_refused():
    with pytest.raises(ValueError, match="no similarity floor"):
        neighbors.floor_for("some-new-model")
