from conftest import run_scan, search

from bl_worker.embed import HashEmbedder

QUERY = "the gel"


def test_rrf_ranks_a_file_found_both_ways_first(rt, conn, make_lab):
    """HashEmbedder only matches exact words and Postgres drops "the" as a stopword, so a
    file can match by keyword alone ("gelatin" is a prefix match for gel:*) or by vector
    alone (it repeats "the"). The 55 fillers also share "the", which pushes the keyword-only
    file, sharing no word with the query, past the vector list's top 50."""
    lab = make_lab()
    lab.write("both.txt", "the gel gel")
    lab.write("vector_only.txt", "the the the the the the")
    lab.write("keyword_only.txt", "gelatin stock")
    for i in range(55):
        lab.write(f"filler/f{i}.txt", f"the the the filler {i}")
    run_scan(rt, lab.source_id)

    rows = search(conn, lab.id, QUERY, HashEmbedder().embed_query(QUERY))
    by_name = {r["locations"][0]["original_name"]: r for r in rows}
    both, vec, kw = by_name["both.txt"], by_name["vector_only.txt"], by_name["keyword_only.txt"]

    assert rows[0] is both
    assert both["keyword_rank"] is not None and both["vector_rank"] == 1
    assert vec["keyword_rank"] is None and vec["vector_rank"] == 2
    assert kw["keyword_rank"] is not None and kw["vector_rank"] is None
    assert {both["keyword_rank"], kw["keyword_rank"]} == {1, 2}
    for r in rows:
        expected = sum(1 / (60 + k) for k in (r["keyword_rank"], r["vector_rank"]) if k)
        assert abs(r["score"] - expected) < 1e-12
    assert all(r["keyword_rank"] is None for r in rows if r not in (both, kw))
    assert both["snippet"] == "the gel gel"


def test_keyword_only_search_when_there_is_no_query_embedding(rt, conn, make_lab):
    lab = make_lab()
    lab.write("AB/P450/batch3/final_v2_REAL.xlsx.txt", "OD600 readings")
    lab.write("CD/unrelated.txt", "ordering list")
    run_scan(rt, lab.source_id)
    rows = search(conn, lab.id, "final batch3", None)
    assert [r["locations"][0]["path"] for r in rows] == ["/AB/P450/batch3/final_v2_REAL.xlsx.txt"]
    assert rows[0]["vector_rank"] is None
