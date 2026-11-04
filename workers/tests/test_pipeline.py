import os
from dataclasses import replace

import pytest
from conftest import run_scan, search

from bl_worker import process, samples, scan
from bl_worker.embed import HashEmbedder
from bl_worker.process import Outcome

hash_embedder = HashEmbedder()


def snapshot(conn, lab_id, *, portable=False):
    """Every derived row for a lab. `portable` drops what differs between two labs."""
    loc_cols = "path, original_name, size, sha256, index_state, index_error, deleted_at is null"
    if not portable:
        loc_cols = "id, external_id, modified_at, source_rev, indexed_at, " + loc_cols
    shas = "(select sha256 from file_locations where lab_id = %(lab)s)"
    queries = {
        "locations": f"select {loc_cols} from file_locations where lab_id = %(lab)s order by path",
        "blobs": f"select * from blobs where sha256 in {shas} order by sha256",
        "extractions": "select sha256, extractor, extractor_version, kind, content, meta"
        f" from extractions where sha256 in {shas} order by 1, 2",
        "chunks": "select sha256, ord, text, embedding::text, embed_model from chunks"
        " where lab_id = %(lab)s order by sha256, ord",
        "previews": "select sha256, replace(storage_key, %(lab)s::text, 'LAB'), width, height"
        " from previews where lab_id = %(lab)s order by sha256",
    }
    queries["blobs"] = queries["blobs"].replace("select *", "select sha256, size, mime, file_kind")
    return {name: conn.execute(q, {"lab": lab_id}).fetchall() for name, q in queries.items()}


def fill_lab(lab):
    lab.write("AB/P450/batch3/gel_notes.pdf", samples.pdf(["SDS-PAGE of P450 batch 3"] * 3))
    lab.write("AB/P450/batch3/IMG_4821.jpg", samples.gel_jpeg(seed=7))
    lab.write("CD/plates/plate_export.csv", samples.csv_text([["Well", "OD600 (AU)"], ["A1", 0.4]]))
    lab.write("AB/buffers/tris.txt", "Tris-HCl pH 8.0, 150 mM NaCl")
    lab.write("CD/old/tris.txt", "Tris-HCl pH 8.0, 150 mM NaCl")


def test_duplicates_share_one_blob_one_chunk_set_and_one_search_row(rt, conn, make_lab):
    lab = make_lab()
    same = samples.pdf(["Ni-NTA elution of P450 batch 3, 250 mM imidazole"])
    lab.write("AB/P450/batch3/elution.pdf", same)
    lab.write("CD/archive/elution_copy.pdf", same)

    assert run_scan(rt, lab.source_id) == [Outcome.INDEXED, Outcome.INDEXED]

    shas = conn.execute(
        "select sha256, index_state from file_locations where lab_id = %s", (lab.id,)
    ).fetchall()
    assert len(shas) == 2 and len({s for s, _ in shas}) == 1
    assert {state for _, state in shas} == {"indexed"}
    sha = shas[0][0]
    assert conn.execute("select count(*) from blobs").fetchone() == (1,)
    assert conn.execute("select count(*) from extractions").fetchone() == (1,)
    chunks = conn.execute(
        "select ord, text from chunks where lab_id = %s and sha256 = %s order by ord", (lab.id, sha)
    ).fetchall()
    assert [ord for ord, _ in chunks] == [0, 1]
    assert "/AB/P450/batch3/elution.pdf" in chunks[0][1]
    assert "/CD/archive/elution_copy.pdf" in chunks[0][1]

    rows = search(conn, lab.id, "imidazole elution", hash_embedder.embed_query("imidazole elution"))
    assert len(rows) == 1 and rows[0]["sha256"] == sha
    assert sorted(loc["path"] for loc in rows[0]["locations"]) == [
        "/AB/P450/batch3/elution.pdf",
        "/CD/archive/elution_copy.pdf",
    ]


def test_rescan_is_a_no_op_then_reindexes_only_the_changed_file(rt, conn, make_lab):
    lab = make_lab()
    fill_lab(lab)
    assert run_scan(rt, lab.source_id) == [Outcome.INDEXED] * 5
    first = snapshot(conn, lab.id)

    assert run_scan(rt, lab.source_id) == []
    assert snapshot(conn, lab.id) == first

    lab.write("AB/buffers/tris.txt", "Tris-HCl pH 7.4, 300 mM NaCl")
    assert run_scan(rt, lab.source_id) == [Outcome.INDEXED]
    after = snapshot(conn, lab.id)
    changed = [
        (a, b) for a, b in zip(first["locations"], after["locations"], strict=True) if a != b
    ]
    assert [a[5] for a, _ in changed] == ["/AB/buffers/tris.txt"]
    old, new = changed[0]
    assert new[8] != old[8]  # sha256
    assert new[4] > old[4]  # indexed_at


def test_deleted_file_drops_out_of_search(rt, conn, make_lab):
    lab = make_lab()
    lab.write("AB/zebrafish_notes.txt", "zebrafish morpholino injections")
    lab.write("AB/keep.txt", "zebrafish husbandry log")
    run_scan(rt, lab.source_id)
    q = hash_embedder.embed_query("zebrafish")
    assert len(search(conn, lab.id, "zebrafish", q)) == 2

    (lab.folder / "AB" / "zebrafish_notes.txt").unlink()
    assert run_scan(rt, lab.source_id) == []

    rows = search(conn, lab.id, "zebrafish", q)
    assert [loc["path"] for r in rows for loc in r["locations"]] == ["/AB/keep.txt"]
    deleted = conn.execute(
        "select path from file_locations where lab_id = %s and deleted_at is not null", (lab.id,)
    ).fetchall()
    assert deleted == [("/AB/zebrafish_notes.txt",)]


def test_a_corrupt_file_fails_with_an_error_and_is_retried_on_rescan(rt, conn, make_lab):
    lab = make_lab()
    lab.write("broken.pdf", b"%PDF-1.4 truncated nonsense")
    assert run_scan(rt, lab.source_id) == [Outcome.FAILED]
    state = "select index_state, index_error from file_locations where lab_id = %s"
    st, err = conn.execute(state, (lab.id,)).fetchone()
    assert st == "failed" and err.startswith("pdfplumber:")
    assert search(conn, lab.id, "broken", None) == []

    assert run_scan(rt, lab.source_id) == [Outcome.FAILED]

    lab.write("broken.pdf", samples.pdf(["now a real protocol"]))
    assert run_scan(rt, lab.source_id) == [Outcome.INDEXED]
    assert conn.execute(state, (lab.id,)).fetchone() == ("indexed", None)


class CountingEmbedder(HashEmbedder):
    def __init__(self, model_name="hash-1024"):
        self.model_name = model_name
        self.embedded: list[str] = []

    def embed_documents(self, texts):
        self.embedded += texts
        return super().embed_documents(texts)


def test_unchanged_chunks_keep_embeddings_and_a_new_model_reembeds(rt, conn, make_lab):
    lab = make_lab()
    f = lab.write("notes.txt", "His-tag cleavage with TEV overnight")
    run_scan(rt, lab.source_id)

    same_model = CountingEmbedder()
    os.utime(f, ns=(1, 1))
    assert run_scan(replace(rt, embedder=same_model), lab.source_id) == [Outcome.INDEXED]
    assert same_model.embedded == []

    new_model = CountingEmbedder("hash-v2")
    os.utime(f, ns=(2, 2))
    run_scan(replace(rt, embedder=new_model), lab.source_id)
    assert len(new_model.embedded) == 2
    models = conn.execute("select distinct embed_model from chunks where lab_id = %s", (lab.id,))
    assert models.fetchall() == [("hash-v2",)]


class Crash(Exception):
    pass


STEPS = [
    (process, "_store_blob"),
    (process, "_extract"),
    (process, "_write_chunks"),
    (process, "_embed_chunks"),
    (process, "_write_preview"),
    (scan, "_apply_page"),
    (scan, "_list_all"),
]


@pytest.mark.parametrize(("module", "step"), STEPS, ids=[s for _, s in STEPS])
def test_crash_after_any_step_converges_on_rescan(rt, conn, make_lab, monkeypatch, module, step):
    clean = make_lab("clean")
    fill_lab(clean)
    run_scan(rt, clean.source_id)

    lab = make_lab("crashed")
    fill_lab(lab)
    real = getattr(module, step)

    def crash_after(*args, **kwargs):
        real(*args, **kwargs)
        raise Crash(step)

    monkeypatch.setattr(module, step, crash_after)
    with pytest.raises(Crash):
        run_scan(rt, lab.source_id)
    monkeypatch.setattr(module, step, real)

    run_scan(rt, lab.source_id)
    assert run_scan(rt, lab.source_id) == []
    assert snapshot(conn, lab.id, portable=True) == snapshot(conn, clean.id, portable=True)
    scan_state = "select scan_error, scan_finished_at > scan_started_at from sources where id = %s"
    assert conn.execute(scan_state, (lab.source_id,)).fetchone() == (None, True)


def test_scan_whose_jobs_were_lost_hands_back_the_same_pending_work(rt, conn, make_lab):
    lab = make_lab()
    fill_lab(lab)
    with rt.pool.connection() as c:
        lost = scan.scan_source(c, rt.settings, lab.source_id)
        again = scan.scan_source(c, rt.settings, lab.source_id)
    assert len(lost) == 5 and again == lost


def test_a_restored_file_comes_back(rt, conn, make_lab):
    lab = make_lab()
    f = lab.write("AB/zebrafish_notes.txt", "zebrafish morpholino injections")
    run_scan(rt, lab.source_id)
    data = f.read_bytes()
    f.unlink()
    run_scan(rt, lab.source_id)
    assert search(conn, lab.id, "zebrafish", None) == []

    f.write_bytes(data)
    run_scan(rt, lab.source_id)
    assert len(search(conn, lab.id, "zebrafish", None)) == 1


def test_old_content_of_an_edited_file_is_not_searchable(rt, conn, make_lab):
    lab = make_lab()
    long_text = " ".join(f"aliquot{i}" for i in range(900))
    f = lab.write("log.txt", long_text)
    run_scan(rt, lab.source_id)
    f.write_text("short note")
    run_scan(rt, lab.source_id)
    (sha,) = conn.execute(
        "select sha256 from file_locations where lab_id = %s", (lab.id,)
    ).fetchone()
    texts = conn.execute(
        "select text from chunks where lab_id = %s and sha256 = %s order by ord", (lab.id, sha)
    ).fetchall()
    assert [t for (t,) in texts][1:] == ["short note"]
    assert search(conn, lab.id, "aliquot500", None) == []
