from __future__ import annotations

import re

# Chunks are sized in words, not model tokens, so they stay the same when the embedding
# model changes and only embeddings need redoing. ~375 words is ~500 Qwen3 tokens on this
# kind of text (README.md has the measurement).
WINDOW_WORDS = 375
OVERLAP_WORDS = 40

SEPARATORS = re.compile(r"[_./\\\-]+")


def name_chunk(paths: list[str]) -> str:
    """Chunk 0: every live path of the blob, raw and with separators spaced out."""
    lines = []
    for path in paths:
        lines.append(path)
        lines.append(SEPARATORS.sub(" ", path).strip())
    return "\n".join(lines)


def text_chunks(text: str) -> list[str]:
    # Slice the original text by word spans so line breaks in tables survive into snippets.
    spans = [m.span() for m in re.finditer(r"\S+", text)]
    step = WINDOW_WORDS - OVERLAP_WORDS
    chunks = []
    for start in range(0, len(spans), step):
        end = min(start + WINDOW_WORDS, len(spans)) - 1
        chunks.append(text[spans[start][0] : spans[end][1]])
        if start + WINDOW_WORDS >= len(spans):
            break
    return chunks
