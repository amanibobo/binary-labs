"""Times an embedding service: the cold start, warm query latency, and chunk throughput.

    EMBED_URL=https://<workspace>--binary-embed.modal.run/embed EMBED_API_KEY=... \\
      uv run python scripts/measure_embed.py [--cold] [--queries 50] [--chunks 256]

--cold first waits until the service has been idle long enough to scale to zero (Modal's
dashboard shows 0 containers), then times the first request. It works the same against
`bl serve-embed` on :8787. docs/deploy.md says what the numbers decide.
"""

from __future__ import annotations

import argparse
import os
import statistics
import time

import httpx

from bl_worker import sample_lab
from bl_worker.chunking import name_chunk, text_chunks
from bl_worker.extract import EXTRACTORS, run_extractor
from bl_worker.filekind import detect

QUERIES = [
    "P450 gel",
    "imidazole elution fractions",
    "Priya's SEC run from March",
    "plate reader export with A280 for batch 5 of BM3 heme domain",
]


def sample_chunks(limit: int) -> list[str]:
    chunks = []
    for f in sample_lab.files():
        kind, _ = detect(f.path, f.data)
        extractor = EXTRACTORS.get(kind)
        body = run_extractor(extractor, f.data).content if extractor else ""
        chunks += [name_chunk([f.path]), *text_chunks(body)]
    return (chunks * (limit // len(chunks) + 1))[:limit]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cold", action="store_true", help="time the first request too")
    parser.add_argument("--queries", type=int, default=50)
    parser.add_argument("--chunks", type=int, default=256)
    args = parser.parse_args()
    url = os.environ["EMBED_URL"].rstrip("/")
    headers = {"Authorization": f"Bearer {os.environ['EMBED_API_KEY']}"}
    client = httpx.Client(timeout=300, headers=headers)

    def query(text: str) -> float:
        started = time.perf_counter()
        client.post(url, json={"text": text}).raise_for_status()
        return (time.perf_counter() - started) * 1000

    if args.cold:
        print(f"cold first query: {query(QUERIES[0]) / 1000:.1f} s")
    query(QUERIES[0])
    times = sorted(query(QUERIES[i % len(QUERIES)]) for i in range(args.queries))
    p95 = times[min(len(times) - 1, int(len(times) * 0.95))]
    print(f"warm query over HTTP: p50 {statistics.median(times):.0f} ms, p95 {p95:.0f} ms")
    over = sum(t > 250 for t in times)
    print(f"  {over} of {len(times)} over the search route's 250 ms budget")

    chunks = sample_chunks(args.chunks)
    started = time.perf_counter()
    for i in range(0, len(chunks), 32):
        client.post(f"{url}/documents", json={"texts": chunks[i : i + 32]}).raise_for_status()
    took = time.perf_counter() - started
    print(f"documents: {len(chunks)} sample-lab chunks in {took:.1f} s, {len(chunks) / took:.1f}/s")


if __name__ == "__main__":
    main()
