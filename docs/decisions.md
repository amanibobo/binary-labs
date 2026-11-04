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

Match highlights use Base's blue secondary tag pair (blue700 #175BCC on blue50 light, blue700Dark #93B4EE on blue100Dark dark) instead of accent, because accent text on its light tint measures 4.15:1 and 4.29:1, under 4.5:1.

## 2026-11-04 — visual system: dark file-browser shell (supersedes Base Web style)

Supersedes "visual system: neutral, Base Web style". The app becomes a dark-first file browser (light mode kept, following the system): a left sidebar with the lab switcher, search (⌘K), nav and a folder tree with softly colored folder icons and counts; a main area with breadcrumbs, a "Folders" grid of illustrated SVG folders (each tinted, with file and subfolder counts), and a "Files" table. Neutral grays carry the UI; color is slight and comes from folder tints and file-kind icons. One blue for focus, links and match highlights; amber stays reserved for "check this" labels and Phase 4 flags. Geist Sans and Geist Mono stay. Sentence case everywhere, including sidebar group labels; no decorative badges.

Browsing by folder is new behavior: a `folder_tree` SQL function returns folders with direct and total file counts per lab, under RLS.

## 2026-11-04 — labels: data model

Labels are keyed by `(lab_id, sha256)` like chunks, so a duplicate carries one label. `corrections` points at that pair, not at a `label_id`. Members never write `labels`: inserting a `corrections` row (through `correct_label` or `undo_correction`, both `security invoker`) runs a trigger that applies it as `auth.uid()` in the same statement and records the full state before and after. Sending the current values back records an acceptance. An undo restores the exact prior state, only for the person who made the change and only if nothing changed since. `experiments.protocol_id` waits for the protocols table. Members add and edit experiments and people; admins remove them.

## 2026-11-04 — labels: tiers and learning

Tier 2 is `claude-haiku-5-5` at low effort; Tier 3 is `claude-sonnet-5-5` at medium effort with the server-side refusal fallback on. Both return strict JSON (structured outputs), parsed again at our boundary; a malformed answer counts as no answer. Images get a Tier 2 description from their 640 px thumbnail, stored as an `image_caption` extraction and chunked for search. Model answers are cached in `model_calls` by (lab, sha256, purpose, model, prompt version), which is also the cost ledger. Without `ANTHROPIC_API_KEY` labels come from Tier 1 rules alone, capped at 0.8 confidence so a rules-only label always gets a glance.

A correction teaches folder rules (this folder means this experiment or person) and name templates (files named like `plate07_read1.csv` are named "Plate 07 … read 1"), stored in `label_rules`. Learning waits 15 s so an undone correction is never learned; undoing a learned one deletes its rules. Similar files are re-suggested from cached answers without new model calls: a taught rule lifts `check` to `suggested`, never to `accepted`, and leaves `needs_look` alone.

## 2026-11-04 — amber marks "check this" too

The PRD reserves amber for flags and "check this" labels; the earlier visual-system entry said flags only. Amber now marks `check` labels as well, and nothing else in the app uses it. Base's warning text on warning background measures 2.83:1 light and 1.95:1 dark, so the pair is Base's yellow tag colors: `#845201` on `#FDF2DC` (5.93:1) light, `#F3DCAE` on `#39240A` (10.95:1) dark.

## 2026-11-04 — measured: label eval on the sample lab

`sh workers/scripts/eval_labels.sh` (real models, clean database, 51 files, 46 unique): 89.1% accepted without edits (41/46). Name 89.1%, date 89.1%, experiment 97.8%, person 95.7%, instrument 93.5%. Every miss was a file sent to Needs a look (three unreadable formats, one unlabeled phone photo, one file whose folder and content disagree); no suggested label was wrong. Cost $0.0029 per file, 93% of it Tier 3: Haiku rates itself under 0.85 on most files, so 34 of 46 went on to Sonnet. 29 of 46 labels carry the "check this" marker. A run on the same code a few minutes earlier scored 87.0%, so expect a few points of run-to-run spread. The thresholds remain the PRD's starting guesses.

## 2026-11-04 — protocols and tutorials

Protocols and tutorials live in our database, not in Dropbox, because Dropbox access is read-only. One `protocols` table with `kind` (`protocol` or `tutorial`); a tutorial is a how-to page that never carries expected values. Every save inserts an immutable `protocol_versions` row (title, Markdown body, `expected_values` JSON left empty until Phase 4, author, note) and moves `protocols.current_version_id`, so a Phase 4 flag can cite the exact version it checked against. A save names the version it started from and fails if someone saved in between, so two people never overwrite each other silently.

The body is Markdown, rendered without raw HTML. Steps are a numbered list in that Markdown; a structured step model waits for Phase 2's voice-to-steps. A page links files from the index (a demo video, an example gel, the original .docx), each opening in Dropbox like any search result. "Start from a file" fills a new page with an indexed file's extracted text and links that file, so a lab's existing protocol documents become pages without retyping; no model rewrites them. `experiments.protocol_id` now points at `protocols`.

Members create and edit; admins archive. Archiving hides a page but keeps its versions, since flags may cite them. Search shows matching protocols (keyword match on title and body) above files. Every create, edit and archive goes to `audit_log`.

## 2026-11-04 — top bar instead of the sidebar

The sidebar goes; the app returns to the earlier top bar: "Binary Labs", then Search, Browse, Protocols, Needs a look (with its count) and Settings as tabs, with search (⌘K) and the account menu on the right. On phones the tabs move into the account menu. The dark look, folder tints and folder art stay. Folders are reached through Browse, since the sidebar's folder tree is gone.

## 2026-11-04 — deleting a lab and disconnecting Dropbox

**Delete the lab** is an admin action in Settings, confirmed by typing the lab's name. It takes effect at once: the lab disappears for every member (membership checks treat a lab marked for deletion as gone), the Dropbox token is deleted and revoked with Dropbox, and scans stop. A worker job then removes the lab's previews from the preview store (everything under `<lab_id>/`), deletes the lab row so every lab-scoped row cascades away, and deletes blobs and extractions that no other lab still references. It runs within minutes, well inside the PRD's 7 days, and is safe to re-run if interrupted. A `lab_deletions` row keeps only the lab id, who asked, when, when it finished and row counts, so we can prove the deletion happened without keeping any lab content. There is no undo; the lab's own files in Dropbox are untouched and could be indexed again, but protocols exist only with us, so the confirmation offers a Markdown download of every protocol first. The PRD's confirmation email waits for the mail service (Resend); until then the person who deleted sees a confirmation page.

**Disconnect Dropbox** is an admin action on the Dropbox section. It deletes the stored token, revokes it with Dropbox, and stops scans at once. The index stays searchable, previews keep working, and "Open in Dropbox" links still work for anyone with Dropbox access. Connecting again resumes from a fresh listing.

## 2026-11-04 — Phase 2 starts; uploads and our own storage

Phase 2 starts at the operator's call, before the Phase 1 pilot gates in the PRD have been measured in a real lab. Build order: uploads and storage first (they decide Phase 2's "done when"), then voice talk-through to steps, then procedure videos.

Uploaded files are stored whole, content-addressed, in the same object store as previews (R2 in the pilot, a local folder in dev and tests), under `<lab_id>/files/<sha256>`, so lab deletion's prefix delete covers them. The PRD's ~2 MiB content-defined shards and manifests wait for Phase 3: they pay off for large instrument files and resumable uploads, not for bench photos and screenshots. Each lab gets one `upload` source; an uploaded file is a `file_locations` row on it and goes through the same scan, extract, label and search pipeline as a Dropbox file. Uploads are the first data we hold that the lab has no other copy of, so they count toward deletion and need a download path.
