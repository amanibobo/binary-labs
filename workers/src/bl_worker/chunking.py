from __future__ import annotations

import re

# Windows are sized by an estimate of Qwen3 tokens rather than the tokenizer itself, so
# chunks stay put when the embedding model changes (only embeddings are redone) and tests
# need no model download. Qwen splits numbers into single digits, so lab tables cost ~3
# tokens a word; counting letter runs, digits and punctuation tracks it: on the sample lab
# real tokens were 1.10-1.38x this count, median 1.17 (README.md has the measurement).
TOKENS_PER_PIECE = 1.17
WINDOW_TOKENS = 500
OVERLAP_TOKENS = 50

PIECE = re.compile(r"[^\W\d_]+|\d|[^\w\s]|_")
WORD = re.compile(r"\S+")
SEPARATORS = re.compile(r"[_./\\\-]+")


def estimate_tokens(text: str) -> float:
    return len(PIECE.findall(text)) * TOKENS_PER_PIECE


def name_chunk(paths: list[str]) -> str:
    """Chunk 0: every live path of the blob, raw and with separators spaced out."""
    lines = []
    for path in paths:
        lines.append(path)
        lines.append(SEPARATORS.sub(" ", path).strip())
    return "\n".join(lines)


def text_chunks(text: str) -> list[str]:
    """~WINDOW_TOKENS windows on word boundaries, each starting ~OVERLAP_TOKENS back."""
    words = [(m.start(), m.end(), estimate_tokens(m.group())) for m in WORD.finditer(text)]
    chunks = []
    start = 0
    while start < len(words):
        end, size = start, 0.0
        while end < len(words) and (end == start or size + words[end][2] <= WINDOW_TOKENS):
            size += words[end][2]
            end += 1
        # Slice the original text so line breaks in tables survive into snippets.
        chunks.append(text[words[start][0] : words[end - 1][1]])
        if end == len(words):
            break
        back, overlap = end, 0.0
        while back > start + 1 and overlap + words[back - 1][2] <= OVERLAP_TOKENS:
            back -= 1
            overlap += words[back][2]
        start = back
    return chunks
