# Design: first slice

Connect, scan, extract, search. No labels yet. Read `prd.md` and `decisions.md` first; this file fixes the shapes both halves build against.

## Layout

```
db/migrations/    plain SQL, applied in order; the contract between web and worker
db/test/          auth stub for local Postgres (tests only, never applied to Supabase)
workers/          Python 3.12 (uv): sources, scan, extract, embed, FastAPI /embed
apps/web/         Next.js app: sign-in, create lab, connect Dropbox, search
apps/landing/     marketing page (separate app)
```

No pnpm workspace. Each app has its own `package.json`.

## Who writes what

- The **worker** writes every row derived from files: `blobs`, `file_locations`, `extractions`, `chunks`, `previews`, and the scan state on `sources`. It connects as the table owner, so RLS doesn't apply to it.
- The **web app** writes `labs` and `members` (through `create_lab`), the `sources` row on connect, `scan_requested_at`, and `audit_log`. It reads through Supabase with the user's session, so RLS always applies. The service role key is used only to invite members.
- **Uploads** are the one place the web app writes a location: `record_upload` (`security definer`, membership checked) inserts the `file_locations` row and its `uploads` row after the route has put the bytes in the object store. The worker still writes the `blobs` row, as for any other file.
- The web app **never enqueues jobs**. It sets `sources.scan_requested_at = now()`. A periodic worker task picks up sources where `scan_requested_at > coalesce(scan_started_at, '-infinity')` and defers `scan_source` with `queueing_lock = source_id`.

## Identity

A file is its content: `blobs.sha256` (lowercase hex text). A place a file lives is a `file_locations` row, unique on `(source_id, external_id)`. Duplicates are several locations sharing one sha256. Chunks, previews and search results are keyed by `(lab_id, sha256)`, so a duplicate is indexed once and shows up as one result listing every path.

## Indexing state machine (per location)

```
pending ──process──▶ indexed
   ▲                    │ source_rev changed on rescan
   └────────────────────┘
pending ──process──▶ failed (index_error set; retried on next rescan)
```

- Listing upserts each entry. If `source_rev` (the Dropbox `content_hash`, or `size:mtime_ns` for local files) differs from the stored value, the location goes back to `pending` and a `process_location` job is deferred.
- `index_state = 'indexed'` requires `sha256 is not null` (a check constraint).
- A Dropbox deleted entry sets `deleted_at`. Search ignores deleted locations, and a blob with no live location drops out of results.
- Scan progress is derived by counting `file_locations` by `index_state` for the source. There are no counters to drift on retries.
- Every step is an upsert or a cache lookup, so re-running a scan or a job converges to the same rows.

## Processing one location

1. `read(external_id)` to bytes, then sha256, then upsert `blobs (sha256, size, mime, file_kind)`.
2. Extract, cached by `(sha256, extractor, extractor_version)`. The extractor is picked from a registry keyed by `file_kind`:
   - `pdf`: pdfplumber text per page
   - `spreadsheet`: openpyxl or csv (sheet names, header row, first 50 rows, units in headers)
   - `document`: python-docx paragraphs and tables
   - `text`: utf-8 decode (txt, md)
   - `image`: Pillow EXIF only (`kind = 'image_meta'`), no text
   - `other`: none
3. Chunks: the filename and folder text go in chunk 0 (`ord = 0`) so names like `final_v2_REAL.xlsx` match by meaning too. After that come ~500-token windows of the extracted text. Replace all chunks for `(lab_id, sha256)` in one transaction.
4. Embed chunks with `embed_model is null` or a different model (`Qwen/Qwen3-Embedding-0.6B`, 1024 dims, no prompt for documents).
5. Preview: a WebP thumbnail for images and the first PDF page (pypdfium2), stored at `<lab_id>/<sha256>.webp` in the preview store (R2 in dev and the pilot, a local folder in tests). The text snippet preview is chunk 1's text, so nothing is stored for it.
6. `index_state = 'indexed'`, `indexed_at = now()`.

## Search

`search_files(p_lab_id, p_query, p_query_embedding, p_file_kinds, p_path_prefix, p_modified_from, p_modified_to, p_limit)` is a SQL function, `security invoker`, so RLS applies to the caller.

- **Keyword list:** prefix tsquery built from the query's words (`p450:* & gel:*`), matched against `chunks.tsv` and `file_locations.name_tsv`. Ranked by `ts_rank_cd`, best rank per sha256.
- **Vector list:** `chunks.embedding <=> p_query_embedding`, best distance per sha256, top 50. Skipped when the embedding is null.
- **Merge:** reciprocal rank fusion, `sum(1 / (60 + rank))` per sha256.
- **Returns one row per sha256:** score, `keyword_rank`, `vector_rank` (either can be null; that's the "why it matched"), the best matching chunk text as the snippet, and the live locations as JSON.

The web app calls the worker's `POST /embed` with a 250 ms timeout. On error or timeout it calls `search_files` with a null embedding and returns `{ kind: "keyword", reason }`. Otherwise it returns `{ kind: "hybrid" }`.

## Secrets

`TOKEN_ENCRYPTION_KEY` is 32 random bytes, base64-encoded, shared by web and worker. `sources.token_ciphertext` is `nonce(12) || ciphertext || tag(16)`, AES-256-GCM, holding the Dropbox **refresh** token (`token_access_type=offline`). The worker mints short-lived access tokens with the app key and secret.

Dropbox scopes: `files.metadata.read files.content.read account_info.read`. No write scope exists in the app config, and no write endpoint appears in the code.

## Env

See `.env.example` at the repo root. The web app reads `apps/web/.env.local`, and the worker reads `workers/.env`.

## Browse

`folder_tree(p_lab_id)` and `folder_files(p_lab_id, p_path, p_limit, p_offset)` (migration 0005) are `security invoker`, so RLS applies. Folder paths are relative to the source root (`""`, `P450`, `P450/batch3`) and only live, indexed locations count. The sidebar tree and the browse page both read `folder_tree`; `/api/browse` pages through `folder_files` 100 rows at a time.

Browse is the only folder view now (the sidebar tree is gone). Folder tints come from `apps/web/src/lib/tints.ts`: a top-level folder's path hashes to one of six muted tints, and its subfolders use the lighter shade of the same tint.

## Protocols

Migration 0006 adds `protocols`, immutable `protocol_versions` and `protocol_files`. Members write through `create_protocol`, `save_protocol`, `link_protocol_file` and `unlink_protocol_file`; admins through `archive_protocol`. All are `security invoker`, and triggers do the checks: a version names the one it was edited from (`based_on`), must start from the current one or fail with `BL101`, and gets the next number. `unique (protocol_id, based_on)` keeps history a line even if two saves race. Triggers also write every create, save, archive, link and unlink to `audit_log`.

`file_text` (`security definer`, membership checked) hands a page the extracted text of a file it starts from, since `extractions` are closed to members. `search_protocols` matches current titles and bodies with the same prefix query as file search; `/api/search` returns its hits as `protocols` beside the files, and none when a file filter is set.

Pages render Markdown with react-markdown and remark-gfm. Raw HTML stays text, and images render as links.

## Deleting a lab and disconnecting Dropbox

Migration 0007. Both actions are `security invoker` functions an admin calls, and the database does the rest: `request_lab_deletion(p_lab_id, p_confirm_name)` checks the typed name (`BL201`), sets `labs.deletion_requested_at`, nulls every token, stops scans, and writes `lab_deletions` and a `lab.delete` audit row. `is_lab_member` and `is_lab_admin` are false from then on, so RLS hides every row at once. `disconnect_source(p_source_id)` nulls the token; a trigger sets `disconnected_at`, clears the cursor and writes `source.disconnect`. Writing a new token to the same row reconnects it and requests a fresh scan.

The web app reads the refresh tokens with the service role before calling either function, then revokes them with Dropbox (`/2/auth/token/revoke`) once the call succeeds. A failed revoke is logged and never undoes the request.

The worker's `sweep_deletions` (every 10 s) queues `delete_lab` for each unfinished `lab_deletions` row, one per lab. `delete_lab` takes the lab's advisory lock exclusively (file processing holds it shared), deletes `<lab_id>/` from the preview store, deletes the lab row so lab tables cascade, deletes blobs and extractions no other lab references, and stamps `completed_at` and `counts` in the same transaction. `counts` has one key per lab table plus `jobs`, `blobs`, `extractions` and `preview_files`; the confirmation page at `/deleted?lab=<id>` reads it (only the requester can).

Every job that reads a source checks `scan.LIVE_SOURCE`: a folder, no `disconnected_at`, and a lab not marked for deletion. A disconnected source keeps its rows, so search, previews and labels keep working on the existing index.

## Uploads

Migration 0008. Each lab has one `upload` source (`root_path` `/`), created by the first `record_upload`; a partial unique index keeps it to one. An upload is a `file_locations` row on it whose `external_id` and `source_rev` are the file's sha256, so the same bytes sent twice, by anyone in the lab, are one location, and a retry after a dropped answer is harmless. Its path is `/Uploads/<experiment>/<name>`, which is where Browse shows it. The `uploads` row keeps who sent it (`uploaded_by` and their `people` row), when (`uploaded_at`, plus `uploaded_on`, the sender's own calendar day) and the experiment they picked, which `record_upload` matches by name or alias or creates.

```
phone ──POST /api/uploads (raw body, x-upload-* headers)──▶ route
  route: stream to a temp file, sha256, cap 50 MB ──▶ object store <lab_id>/files/<sha256>
  route: record_upload ──▶ file_locations (pending) + uploads; sources.scan_requested_at = clock_timestamp()
worker: schedule_scans ──▶ scan_source (an upload source isn't listed; it returns its pending locations)
  ──▶ process_location (UploadReader reads the store and checks the hash) ──▶ label_blob
```

- `proxy.ts` skips `/api/uploads`, because with a proxy Next buffers request bodies in memory and cuts them at 10 MB. The route needs `Content-Length` and answers 408 for a body that ends short of it.
- Tier 1 reads the `uploads` row: the sender is the person and the picked experiment is the experiment, both strong; the upload day is the date unless the photo carries an EXIF capture time.
- `/api/files/<location id>` opens an uploaded file: RLS finds the location, the key is built from the viewer's lab, and only images, PDFs and plain text are served inline (everything else downloads, with `nosniff`). Each open is `file.download` in `audit_log`. Search, Browse and protocol pages pick "Open file" or "Open in Dropbox" from `openTarget` in `lib/format.ts`, keyed by source kind.
- The upload page sends one file at a time from a queue kept for the page's life (`lib/upload-queue.ts`): a dropped upload retries after 2, 5 and 15 s, then waits for Retry or for the browser to come back online, and the page warns before closing while anything is unsent.
- `scripts/e2e-upload.sh` runs the route's core (`lib/upload-accept.ts`) and the real worker on local Postgres and a local store.

## Talk-throughs

Migration 0009. A `talk_throughs` row ties one recording (`location_id`, unique) to what it's for: a new page of some `kind`, or a page and the version on screen while recording (`protocol_id` and `base_version_id`, both or neither). `draft` is `waiting`, `ready` (title and body set), `failed` (may work on a retry) or `unavailable` (won't; the transcript is offered instead). `used_version_id` is set once, by the save that used the steps. Members read the table under RLS and write only through functions.

```
recorder ──POST /api/uploads (x-upload-purpose: talk-through)──▶ acceptTalkThrough
  same temp file, sha256 and store key as an upload; cap audio_max_bytes() (100 MB)
  record_talk_through ──▶ record_file (the old record_upload body) + talk_throughs (waiting)
worker: scan ──▶ process_location: a location with a talk_throughs row is transcribed
  (Transcriber, TRANSCRIBER=elevenlabs|whisper) ──▶ extraction kind transcript ──▶ chunks
  ──▶ draft_steps (also queued by tend_talk_throughs every 10 s) ──▶ talk_throughs.draft
page: talk_through(id) polled every 2 s until settled ──▶ /talk-throughs/<id>/edit
  ──▶ use_talk_through ──▶ create_protocol or save_protocol + link_protocol_file + mark used
```

- `talk_through(id)` is `security definer`, because transcripts are extractions and closed to members; it answers only when `is_lab_member` holds for the talk-through's lab. `open_talk_throughs` (invoker) lists a page's unused ones, or with no page the caller's own new-page ones.
- `retry_talk_through` puts a failed recording back to pending and requests a scan, and puts a failed draft back to waiting.
- `use_talk_through` raises the protocol codes plus `BL105` (already used) and `BL106` (not transcribed yet). `mark_talk_through_used` accepts only a version the caller saved in the same transaction.
- The web state machine is `TalkThroughStatus` in `lib/talk-throughs.ts`; the recorder's is `lib/recorder-state.ts`. The fixture page is `/dev/fixtures/talk-throughs?view=…`, and screenshots record on Chromium's fake microphone.

## Procedure videos

Migrations 0010 and 0011. A page's video is a `protocol_files` row whose blob has `file_kind = 'video'`. `pending_protocol_files` holds a video added to a page whose bytes the worker hasn't verified yet; `videos` holds each lab's transcript state per video blob (`waiting`, `ready`, `failed`, `unavailable`). Members read both under RLS and may delete a pending row; the worker writes the rest.

```
page ──POST /api/videos/uploads {protocolId, name, size, type}──▶ page + cap check, multipart at <lab>/uploads/<id>
     ──POST …/parts/<n> {storeId, size}──▶ presigned R2 UploadPart (size signed), or PUT …/parts/<n> on the local store
     ──POST …/complete {parts, …}──▶ join, size check, sha256 read back on the server, move to <lab>/files/<sha256>
        record_video ──▶ record_file (/Uploads/Videos/<name>) + pending_protocol_files, or link at once if the lab
        already holds the same verified bytes
worker: process_location ──▶ blob kind video ──▶ link_pending (link_protocol_file as requested_by) ──▶ poster preview
worker: tend_videos (10 s) ──▶ videos rows for video blobs on a page ──▶ transcribe_video (locked per sha256)
        ffmpeg audio track ──▶ Transcriber ──▶ extraction transcript ──▶ rechunk ──▶ videos.transcript = ready
page: protocol_videos(protocol) polled every 3 s until settled; <video> on /api/files/<location> with ranges
```

- `protocol_videos` is `security definer` (transcripts are extractions) and answers only when the caller is a member of the page's lab. Linked videos come first, in link order, then pending ones (`preparing`, or `failed` with the worker's error).
- `/api/files/<location>` serves an upload from the store with byte ranges (`lib/serve-file.ts`; R2 by presigned redirect) and a Dropbox video by a `get_temporary_link` redirect. Only a request starting at byte 0 writes `file.download`.
- The page's upload state machine is `lib/video-upload-state.ts`: the next step (start, part n, complete) is read off the upload, and a dropped step retries after 2, 5 and 15 s. `lib/video-upload.ts` is the routes' core; `lib/object-store.ts` has the multipart calls for R2 and the local store.
- The Files list leaves videos out; they play in the Videos section above it. Linking a video through the Files picker refreshes the Videos section.
- ffmpeg is optional (`FFMPEG_PATH`, `bl_worker/video.py`): no ffmpeg means no poster and an unavailable transcript, never a failed file.
- `scripts/e2e-video.sh` runs the routes' core and the real worker on local Postgres and a local store. Fixtures: `/dev/fixtures/protocols?view=page|videos|no-videos`, media from `/dev/fixtures/media/`.
