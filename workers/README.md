# Binary Labs worker

The Python half of the first slice: it lists a lab's files, hashes and extracts them, embeds chunks for search, renders previews, and serves `POST /embed` for search queries. `docs/design.md` is the contract. This file covers how to run the worker and the choices design.md leaves open.

## Commands

All commands run from `workers/` and read `workers/.env` (names in the repo-root `.env.example`).

```
uv sync
uv run bl migrate [--test-stub]   # db/migrations in order, then the Procrastinate schema
uv run bl worker [--concurrency 4] # jobs plus the 10 s scan scheduler
uv run bl serve-embed             # FastAPI on :8787
uv run bl scan-local <lab_id> <folder>   # dev: create or reuse a local source, request a scan
uv run python scripts/make_sample_lab.py ../.data/sample-lab
uv run bl sample-lab <folder>     # dev: a lab over that folder, with its experiments and people
uv run bl eval-labels <db_url>    # score stored labels against evals/labels_expected.json
uv run bl demo-lab --admin-email <email> [--replace | --delete] [--no-worker]
                                  # a fake, fully populated lab for an existing user (decisions.md)
sh scripts/eval_labels.sh         # all of the above on a fresh local database, then the score
```

`bl worker --until-idle` exits once the queue is empty. Labeling needs `ANTHROPIC_API_KEY`; without it, labels come from Tier 1 rules alone and nothing fails.

`bl migrate` records each file in `schema_migrations`, so a rerun applies nothing. `--test-stub` applies `db/test/auth_stub.sql` first, for local Postgres only. After every run it revokes the Procrastinate tables and functions, and `schema_migrations`, from `PUBLIC`, `anon` and `authenticated`, and turns RLS on for them. Supabase grants new public objects to those roles, and PostgREST would otherwise let a signed-out caller read or enqueue jobs.

Set `EMBED_MODEL=hash-1024` to run the worker with the deterministic fake embedder, which skips the 1.2 GB model download.

With `EMBEDDER=remote` the worker loads no model and sends file chunks to the embedding service at `EMBED_URL` (`POST /embed/documents`, 32 at a time, with `EMBED_API_KEY`): `bl serve-embed` in dev, `modal_embed.py` on a Modal GPU in production. The production image (`Dockerfile`, `fly.toml`) leaves out the `local-embed` group, so it has no torch. `BINARY_ENV=production` makes `bl worker`, `bl migrate` and `bl serve-embed` stop at startup with a list of every missing or malformed variable. `docs/deploy.md` has the hosting steps.

## Tests

```
uv run ruff check && uv run ruff format --check
uv run pytest            # needs local Postgres 17 + pgvector; creates and drops binary_labs_worker_test
uv run pytest -m slow    # loads the real Qwen3 model
```

## Choices design.md leaves open

**Chunk size.** Chunks are sized by an estimate of Qwen3 tokens rather than by the tokenizer. That keeps chunk boundaries fixed when the embedding model changes, so a model swap redoes embeddings and not chunks, and tests need no model download. Words are a poor proxy here. On the sample lab, Qwen3 averaged 2.98 tokens per word, because it splits numbers into single digits and lab tables are mostly numbers. The estimator counts letter runs, single digits and punctuation marks. Across 89 sample passages, real tokens were 1.10 to 1.38 times that count (median 1.17). With a 500-token budget and a 50-token overlap, full windows on the sample lab came out at 482 to 532 real tokens.

**Chunk 0.** Chunk 0 holds every live path of the blob, each raw and with separators turned into spaces. Duplicates share one chunk set, so chunk 0 can't belong to one location. Each location job takes an advisory lock on `(lab_id, sha256)` before it writes chunks, so the last writer always sees every location.

**Kept embeddings.** Rewriting a chunk with the same text keeps its embedding. Only new or changed text, or chunks from another model, get embedded again.

**File kinds.** Detection uses `filetype` (pure Python) for magic bytes, so libmagic isn't needed. Content beats the extension. A PDF named `.txt` is a PDF.

**Which errors fail a location.** An unreadable source file, a parser error, or a render error marks the location `failed` with `index_error`. Database, network and model errors fail the job instead, and Procrastinate retries it. The scheduler also retries jobs stalled by a worker that died.

**Labels.** `process_location` defers `label_blob` for each blob it finishes, and the 10 s `tend_labels` task learns from settled corrections and queues labels for blobs that have none. `labels/tier1.py` holds the rule tables, `labels/decide.py` the thresholds and Tier 3 routing, `labels/learning.py` the rules learned from corrections, and `models.py` the one interface every model call goes through (`FakeModels` in tests). Each call logs its tokens, its cost and the lab's running total.

## Known gaps

- When a file changes, its old blob's chunks and preview stay in the lab. Search ignores them because no live location points at them. Nothing collects them yet.
- When one duplicate is deleted, chunk 0 still lists its path until another location of that blob is processed again.
- `LocalFolderSource` and `DropboxSource.read` hold the whole file in memory.
- A file edited in place gets a new sha256 and so a new label; its old correction doesn't carry over unless a learned rule covers it.
- Bumping `LABEL_PROMPT_VERSION` doesn't relabel existing files on its own.
