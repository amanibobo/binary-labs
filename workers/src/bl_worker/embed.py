from __future__ import annotations

import hashlib
import logging
import math
import re
import threading
import time
from collections.abc import Callable
from typing import Protocol

import httpx

log = logging.getLogger(__name__)

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
        # A GPU's memory takes a whole request's batch at once; CPU and MPS go a few at a time.
        self._batch_size = 32 if device == "cuda" else 4
        # Worker jobs run in threads; one model on one device takes one batch at a time.
        self._lock = threading.Lock()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        with self._lock:
            vectors = self._model.encode(
                texts, batch_size=self._batch_size, normalize_embeddings=True
            )
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


class EmbedServiceError(Exception):
    """The embedding service failed or answered wrongly; the job fails and is retried."""


class RemoteEmbedder:
    """File chunks and queries embedded by the embedding service (embed_api.py), which runs
    the same model: `bl serve-embed` in dev, workers/modal_embed.py on a GPU in production.
    A scaled-to-zero service takes tens of seconds to answer its first request, so the
    timeout is long; a busy or restarting one gets a few more tries before the job fails."""

    BATCH = 32
    TRIES = 4

    def __init__(
        self,
        url: str,
        api_key: str,
        model_name: str = QWEN,
        *,
        client: httpx.Client | None = None,
        timeout_s: float = 180.0,
        backoff_s: float = 2.0,
    ) -> None:
        self.model_name = model_name
        self.dim = DIM
        self._query_url = url.rstrip("/")
        self._documents_url = f"{self._query_url}/documents"
        self._backoff_s = backoff_s
        self._client = client or httpx.Client(timeout=timeout_s)
        self._headers = {"Authorization": f"Bearer {api_key}"}

    def _post(self, url: str, body: dict[str, object]) -> dict[str, object]:
        for attempt in range(1, self.TRIES + 1):
            try:
                resp = self._client.post(url, json=body, headers=self._headers)
            except httpx.TransportError as e:
                failure = f"{type(e).__name__}: {e}"
            else:
                if resp.status_code == 200:
                    out = resp.json()
                    if out.get("model") != self.model_name:
                        raise EmbedServiceError(
                            f"{url} runs {out.get('model')!r}, not {self.model_name!r}"
                        )
                    return out
                if resp.status_code not in (408, 429, 500, 502, 503, 504):
                    raise EmbedServiceError(f"{url} answered {resp.status_code}: {resp.text[:200]}")
                failure = f"HTTP {resp.status_code}"
            if attempt < self.TRIES:
                log.warning("embedding service: %s; try %d of %d", failure, attempt, self.TRIES)
                time.sleep(self._backoff_s * 2 ** (attempt - 1))
        raise EmbedServiceError(f"{url}: {failure} after {self.TRIES} tries")

    def _vectors(self, raw: object, count: int) -> list[list[float]]:
        if not isinstance(raw, list) or len(raw) != count:
            raise EmbedServiceError(f"expected {count} embeddings")
        if any(not isinstance(v, list) or len(v) != DIM for v in raw):
            raise EmbedServiceError(f"expected {DIM}-dim embeddings")
        return raw

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self.BATCH):
            batch = texts[start : start + self.BATCH]
            out = self._post(self._documents_url, {"texts": batch})
            vectors.extend(self._vectors(out.get("embeddings"), len(batch)))
        return vectors

    def embed_query(self, text: str) -> list[float]:
        out = self._post(self._query_url, {"text": text})
        return self._vectors([out.get("embedding")], 1)[0]


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
