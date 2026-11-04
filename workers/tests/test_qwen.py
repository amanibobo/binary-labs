import pytest

from bl_worker.embed import DIM, QWEN, build_embedder

GEL = (
    "SDS-PAGE, 12% Bis-Tris gel. Lane 1 ladder, lanes 2-6 CYP450 BM3 fractions from the "
    "Ni-NTA elution; the band at ~118 kDa is the P450. Stained with Coomassie."
)
BUFFER = (
    "Lysis buffer recipe: 50 mM Tris-HCl pH 8.0, 300 mM NaCl, 10 mM imidazole, 1 mM PMSF. "
    "Filter and store at 4 C."
)


@pytest.mark.slow
def test_qwen_ranks_the_gel_chunk_above_a_buffer_recipe():
    embedder = build_embedder(QWEN)
    gel, buffer = embedder.embed_documents([GEL, BUFFER])
    query = embedder.embed_query("SDS-PAGE gel of P450")

    assert embedder.dim == DIM and len(query) == DIM
    assert abs(sum(x * x for x in query) - 1) < 1e-3

    def cos(a, b):
        return sum(x * y for x, y in zip(a, b, strict=True))

    assert cos(query, gel) > cos(query, buffer) + 0.05
    # Queries carry the instruction prompt; documents don't, so the two differ.
    assert embedder.embed_documents(["SDS-PAGE gel of P450"])[0] != query
