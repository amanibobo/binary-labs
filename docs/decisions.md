# Decisions

## 2026-11-04 — first build scope

The first build is a thin vertical slice of Phase 1: create a lab, connect Dropbox read-only, list and hash files, extract text, and run keyword + vector search with previews.

Labels, corrections, Needs a look, protocol pages and Frigade onboarding come in later builds.

Why: it's the shortest path to the pilot's first goal (find X in under 10 seconds) and tests the content-hash data model before labels depend on it.

## 2026-11-04 — file sources

One `Source` interface with two adapters: a local-folder adapter for tests and dev, and a Dropbox adapter (read-only scopes, `list_folder` cursors) for the real manual check.

Why: tests stay fast and offline, and Phase 2–3 sources (upload, instrument) slot into the same interface.

## 2026-11-04 — database and auth

Hosted Supabase (free project) for dev and the pilot: Postgres + pgvector, Supabase Auth with email magic links, RLS policies on `auth.uid()` via `members`.

Tests run against local Homebrew Postgres 17 + pgvector (`brew install postgresql@17 pgvector`) with a small stub of Supabase's `auth.uid()` (reads `request.jwt.claims`), so lab-isolation tests run offline.

Why: no Docker on the dev machine; dev matches the pilot; tests stay fast.

## 2026-11-04 — embeddings

Local `Qwen/Qwen3-Embedding-0.6B` in the Python worker (sentence-transformers, MPS/CUDA when present), 1024 dims → `chunks.embedding vector(1024)`. Queries get the model's instruction prefix; documents don't. Store the model name with each chunk so a swap can re-embed.

Why: $0 per file, lab text never leaves our machines, and stronger retrieval than bge-small on tables, units and sample IDs. Behind the one model interface, so a hosted model is a one-file swap.

## 2026-11-04 — query embedding at search time

The Python worker also serves a small FastAPI `POST /embed` for search queries; the Next.js search route calls it with a ~250 ms timeout. On timeout or error, search returns keyword-only results and the UI says so.

Keep Qwen3-Embedding-0.6B (embeddings decision above). Measure p50 query-embed latency on the target worker host; if it exceeds 150 ms, swap to `bge-small-en-v1.5` (384 dims) behind the same interface, with a migration and re-embed.

Why: one model on both sides keeps vectors comparable; keyword fallback follows "never block on AI".

## 2026-11-04 — extraction and previews in the first slice

Extract text-bearing files only: PDF (pdfplumber), Excel/CSV (sheet names, header rows, first rows, units), DOCX, TXT/MD. Images and unknown formats are indexed by name, path, dates and EXIF, with a thumbnail. Previews and thumbnails go to R2 under `<lab_id>/<sha256>`.

No OCR or image captions yet; those come with the labeling build (Tier 2 reads images).

Why: enough to test "find X in under 10 seconds" on real files without the cost and scope of image reading; R2 previews don't depend on Dropbox temporary links.

## 2026-11-04 — Supabase project and email

Dev uses the existing Supabase project `binarylabs` (us-east-1, ref `hstjkkdgvotrrqnmqppu`). The worker connects through the session pooler (port 5432), not the transaction pooler, because Procrastinate needs session features. Site URL is `http://localhost:3000`.

The free tier blocks email template edits on the default email sender, and that sender only allows a few emails an hour. Until a custom SMTP provider (likely Resend) is set up, invited people follow the default invite link and then sign in with a magic link; their `members` row already exists. Before the pilot: add SMTP and point the invite template at `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`.

## 2026-11-04 — measured: query embedding and scan

Qwen3-Embedding-0.6B query embed over HTTP, p50 ~45 ms (three runs of 50: 41, 49, 48 ms) on an M4 Mac with MPS; ~563 ms on CPU for the same short query. Cost grows with query length (41 ms at 6 tokens, 97 ms at 84).

Scan of the 51-file sample lab: 24 s, ~97% of it embedding (~1k tokens/s on MPS). Lab text runs ~3 Qwen tokens per word because digits tokenize singly; chunks are sized by a token estimate, not word count.

Consequence: a CPU-only Fly/Railway worker would push every search past the 250 ms timeout into keyword-only mode. For the pilot, serve `/embed` from a machine with a GPU (the PRD's local GPU box or Modal), or swap to `bge-small-en-v1.5` per the earlier decision. Not settled yet.

## 2026-11-04 — visual system: neutral, Base Web style

Supersedes the PRD's color tokens and type. The look follows Uber's open-source Base Web design system (MIT): black, white and a neutral gray scale; black primary buttons; bold, tight headings; pill buttons; modals with a large title and a full-width primary action. One blue (Base accent) for search match highlights, links and focus rings. Amber stays reserved for Phase 4 flags. Light and dark modes both stay.

Icons are Base Web's MIT icon set, with any missing glyphs (folder, file kinds) drawn to match its 24px grid. Type is Geist Sans and Geist Mono, the closest open match to Uber Move, which is proprietary. Nothing Uber-branded (logo, name, Uber Move) is used.
