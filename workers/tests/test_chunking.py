import itertools

from bl_worker.chunking import OVERLAP_WORDS, WINDOW_WORDS, name_chunk, text_chunks


def test_windows_cover_every_word_with_overlap():
    words = [f"w{i}" for i in range(1000)]
    chunks = [c.split() for c in text_chunks(" ".join(words))]
    assert all(len(c) <= WINDOW_WORDS for c in chunks)
    assert chunks[0][0] == "w0" and chunks[-1][-1] == "w999"
    for a, b in itertools.pairwise(chunks):
        assert a[-OVERLAP_WORDS:] == b[:OVERLAP_WORDS]
    covered = {w for c in chunks for w in c}
    assert covered == set(words)


def test_short_and_empty_text():
    assert text_chunks("") == []
    assert text_chunks("  one\n two ") == ["one\n two"]


def test_line_breaks_survive_into_chunks():
    assert text_chunks("Columns: a | b\nA1 | 1") == ["Columns: a | b\nA1 | 1"]


def test_name_chunk_spaces_out_separators_for_every_path():
    text = name_chunk(["/AB/P450/batch3/final_v2_REAL.xlsx", "/CD/final_v2_REAL.xlsx"])
    assert text.splitlines() == [
        "/AB/P450/batch3/final_v2_REAL.xlsx",
        "AB P450 batch3 final v2 REAL xlsx",
        "/CD/final_v2_REAL.xlsx",
        "CD final v2 REAL xlsx",
    ]
