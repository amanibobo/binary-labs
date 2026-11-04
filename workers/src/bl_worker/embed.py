from __future__ import annotations

import hashlib
import math
import re
import threading
from collections.abc import Callable
from typing import Protocol

DIM = 1024
QWEN = "Qwen/Qwen3-Embedding-0.6B"
HASH = "hash-1024"


class Embedder(Protocol):
    model_name: str
    dim: int

    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...


class QwenEmbedder:
    def __init__(self, model_name: str = QWEN) -> None:
        import torch
        from sentence_transformers import SentenceTransformer

        device = "mps" if torch.backends.mps.is_available() else "cpu"
        if torch.cuda.is_available():
            device = "cuda"
        self.model_name = model_name
        self._model = SentenceTransformer(model_name, device=device)
        self.dim = self._model.get_embedding_dimension() or 0
        # Worker jobs run in threads; one model on one device takes one batch at a time.
        self._lock = threading.Lock()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        with self._lock:
            vectors = self._model.encode(texts, batch_size=16, normalize_embeddings=True)
        return [v.tolist() for v in vectors]

    def embed_query(self, text: str) -> list[float]:
        with self._lock:
            vector = self._model.encode([text], prompt_name="query", normalize_embeddings=True)
        return vector[0].tolist()


class HashEmbedder:
    """Deterministic bag-of-words feature hashing: texts sharing exact words are close."""

    model_name = HASH
    dim = DIM

    def _vector(self, text: str) -> list[float]:
        v = [0.0] * DIM
        for word in re.findall(r"[a-z0-9]+", text.lower()):
            h = int.from_bytes(hashlib.blake2b(word.encode(), digest_size=8).digest())
            v[h % DIM] += 1.0 if (h >> 32) & 1 else -1.0
        norm = math.sqrt(sum(x * x for x in v))
        if norm == 0:
            v[0], norm = 1.0, 1.0
        return [x / norm for x in v]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vector(text)


EMBEDDERS: dict[str, Callable[[], Embedder]] = {
    QWEN: lambda: QwenEmbedder(QWEN),
    HASH: HashEmbedder,
}


def build_embedder(model_name: str) -> Embedder:
    if model_name not in EMBEDDERS:
        raise ValueError(f"unknown EMBED_MODEL {model_name!r}; known: {sorted(EMBEDDERS)}")
    embedder = EMBEDDERS[model_name]()
    if embedder.dim != DIM:
        raise ValueError(f"{model_name} gives {embedder.dim} dims; chunks.embedding is {DIM}")
    return embedder
