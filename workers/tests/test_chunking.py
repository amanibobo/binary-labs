import itertools

from bl_worker.chunking import (
    OVERLAP_TOKENS,
    WINDOW_TOKENS,
    estimate_tokens,
    name_chunk,
    text_chunks,
)

TABLE_ROW = "A1 | 0.123 | 30 | 25.0"


def test_windows_stay_under_the_budget_cover_everything_and_overlap():
    words = [f"lysate{i}" for i in range(1500)]
    chunks = text_chunks(" ".join(words))
    assert len(chunks) > 3
    assert all(estimate_tokens(c) <= WINDOW_TOKENS for c in chunks)
    assert chunks[0].split()[0] == "lysate0" and chunks[-1].split()[-1] == "lysate1499"
    assert {w for c in chunks for w in c.split()} == set(words)
    for a, b in itertools.pairwise(chunks):
        shared = set(a.split()) & set(b.split())
        assert 0 < estimate_tokens(" ".join(shared)) <= OVERLAP_TOKENS


def test_number_heavy_tables_get_fewer_words_per_chunk_than_prose():
    table = "\n".join([TABLE_ROW] * 400)
    prose = " ".join(["purified"] * 2000)
    table_words = len(text_chunks(table)[0].split())
    prose_words = len(text_chunks(prose)[0].split())
    assert table_words < prose_words / 2


def test_short_and_empty_text():
    assert text_chunks("") == []
    assert text_chunks("  one\n two ") == ["one\n two"]


def test_line_breaks_survive_into_chunks():
    assert text_chunks("Columns: a | b\nA1 | 1") == ["Columns: a | b\nA1 | 1"]


def test_a_single_huge_word_is_still_emitted():
    blob = "x" * 5000 + "." * 600
    assert text_chunks(blob) == [blob]


def test_name_chunk_spaces_out_separators_for_every_path():
    text = name_chunk(["/AB/P450/batch3/final_v2_REAL.xlsx", "/CD/final_v2_REAL.xlsx"])
    assert text.splitlines() == [
        "/AB/P450/batch3/final_v2_REAL.xlsx",
        "AB P450 batch3 final v2 REAL xlsx",
        "/CD/final_v2_REAL.xlsx",
        "CD final v2 REAL xlsx",
    ]
