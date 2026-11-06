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
- **Returns one row per sha256:** score, `keyword_rank`, `vector_rank` (either can be null; that's the "why it matched"), the best matching chunk text as the snippet (never chunk 0, the name and path, since migration 0012), and the live locations as JSON.

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

## Charts

Migration 0014. `data_tables` (one row per lab and sha256: `waiting`, `ready` with its `storage_key` and `parser_version`, or `failed` with an error) is written by the worker; members read it under RLS and ask for one through `request_data_table` (`security definer`, membership and spreadsheet checked, `BL104` otherwise). `charts` holds a lab's charts: the file's sha256, the table's name (`sheet`), a title, the spec and an optional `protocol_id`; members insert, update and delete under RLS with column grants, and triggers keep a chart on its lab and file, check the protocol (`BL103`, `BL102`) and write the audit rows. Both are lab tables and blob references for deletion.

```
worker: process_location ──▶ spreadsheet ──▶ tables.parse (bl_worker/tables.py) ──▶ <lab>/tables/<sha256>.json
        data_tables ready (cached by lab, sha256, parser version), or failed; never fails the file
builder: GET /api/tables/<sha> ──▶ missing: POST /api/tables/<sha> ──▶ request_data_table ──▶ waiting
        worker: tend_tables (10 s) ──▶ parse_table (reads a live location, checks the hash) ──▶ ready
        polled every 2 s until ready or failed
save:   POST /api/charts {sha256, sheet, title, spec, protocolId} ──▶ ChartSpec + checkSpec against the table ──▶ insert
        POST /api/charts/<id> {…, basedOn} ──▶ update where updated_at = basedOn, 409 when it moved
```

- The JSON is `{version, cellLimit, tables: [{name, sheet, notes, rows, truncated, rowsInFile, columns: [{id, name, unit, kind, values, invalid}]}]}`; `lib/data-tables.ts` parses it at the boundary. Column ids are spreadsheet letters.
- `lib/chart-geometry.ts` turns a spec, a table and a size into every mark's position; `components/charts/chart-svg.tsx` draws it with screen ink (CSS variables, `--chart-<slot>` in globals.css) or export ink (the light hex values); `chart-figure.tsx` adds the hover readout, arrow keys and the numbers table; `chart-export.tsx` makes the SVG and PNG.
- `lib/chart-store.ts` is the routes' core: it reads tables only under the viewer's lab prefix.
- `scripts/e2e-charts.sh` runs three instrument exports through the real worker on local Postgres and a local store, asks for one table again as a member, then saves charts and exports SVG through the routes' core. Fixtures: `workers/scripts/make_table_fixtures.py` writes the exports (`workers/tests/fixtures/tables/`) and their parsed JSON for the web fixtures; pages at `/dev/fixtures/charts?view=new|akta|bradford|saved|sec|waiting` and `/dev/fixtures/protocols?view=charts`.
- `BL_TEST_DB` (worker) and `BL_WEB_TEST_DB` with `TEST_DATABASE_URL` (web) name the test databases, so two checkouts can run their suites at once.

## Instruments

Migration 0013. An `instruments` row per instrument PC, each with its own `instrument` source (`root_path` `/`). The admin side is `create_instrument`, `renew_pairing_code` and `revoke_instrument` (`security definer`, admin checked, audited as `instrument.create` and `instrument.revoke`) and `lab_instruments` for the list. The uploader side is three functions only the service role may call, each taking the token's sha256: `pair_instrument` (audited as `instrument.pair`, rate limited through `instrument_pair_attempts`), `instrument_session` (also notes `last_seen_at`) and `record_instrument_file`.

```
admin: Settings > Instruments ──addInstrument──▶ create_instrument(lab, name, sha256(code)) ──▶ code shown once
uploader: POST /api/instruments/pair {code} ──▶ pair_instrument ──▶ token (blu_…), stored hashed
uploader, Bearer token: heartbeat every 60 s
  POST files/check {path, sha256, size, modifiedAt} ──▶ { have } (lab store holds the bytes: record the path, send nothing)
  POST uploads ──▶ staged multipart at <lab_id>/uploads/<id> (lib/staged-upload.ts, shared with videos)
  POST uploads/<id>/parts/<n> ──▶ presigned R2 URL, or PUT the same path on the local store
  POST uploads/<id>/complete ──▶ join, size and sha256 checked on the server ──▶ <lab_id>/files/<sha256>
     ──▶ record_instrument_file ──▶ file_locations (external_id = path on the PC, source_rev = sha256)
worker: scan of an instrument source lists nothing ──▶ process_location reads the store by source_rev
  ──▶ label_blob: Tier 1 instrument fact from the source's instrument, at TAUGHT strength
```

- Paths are `<watched folder name>/<path inside it>`; Browse shows them at `Instruments/<instrument name>/…`.
- `proxy.ts` skips `/api/instruments/`, so those routes never see a session and the part PUT isn't buffered. Each route authorizes the token before reading the body (`lib/instrument-routes.ts`); the cores are in `lib/instrument-upload.ts` and the database client in `lib/instrument-db.ts`, which tests swap for plain Postgres (`lib/__tests__/pg-instrument-db.ts`).
- `/api/files/<location>` opens an instrument file from our store by its `source_rev`.
- Tests: `workers/tests/test_instruments.py` (SQL and worker), `apps/web/src/lib/__tests__/instruments.db.test.ts` (the real route handlers), `instruments/uploader/tests` (the uploader against a mock server). `scripts/e2e-instrument.sh` runs the real uploader binary against the real route handlers over HTTP, kills it mid-send and restarts it, then runs the worker. Fixtures: `/dev/fixtures/settings/instruments[?code=shown|paired][&role=member]`.

## Asking the lab and suggestions

Migration 0019. `questions` holds every question asked, its checked answer, the sources retrieval found (as the page shows them) and what it cost; `answer_feedback` one verdict per member per answer. `suggestions` holds what the AI proposed: a `protocol_edit` (title, body and note drafted on `base_version_id`, the fork point) or `labels` (one `suggestion_labels` row per file, setting only the fields that change). `state` is `open`, `approved` or `dismissed`. All four are lab tables; `suggestion_labels` is a blob reference. Members only read them.

`model_calls` now keys a call by its file (`sha256`) or by `cache_key`, the sha256 of the prompt version, model, normalized question and the exact `<sources>` block the model read, so a cached answer is one for the same question over the same sources. The file key stays unique, so the worker is unchanged. `labs.ai_monthly_cap_usd` (default 25) caps `answer` plus `suggestion` spend per calendar month (UTC); `ai_budget(lab)` reports it to members.

```
Search box ──Enter / "Ask the lab"──▶ POST /api/ask {question}  (no ANTHROPIC_API_KEY: 503, the page says asking isn't set up)
  askLab (lib/ask.ts), reads as the member under RLS:
    /embed (1 s) ──▶ ask_context: search_files' top 6 files, each with its best 2 chunks and its table key
                 ──▶ ask_protocols: matching protocols with their current text
                 ──▶ parsed tables from <lab>/tables/<sha>.json (3 tables, 40 rows, 600 cells a file)
    emit sources ──▶ cached_model_output(cache_key)? emit cached sentences
                 ──▶ ai_budget over cap? emit limit (sources stay as the closest files)
                 ──▶ claude-sonnet-5-5, low effort, structured output {sentences: [{text, citations: [{source, cell}]}]}
                     each sentence checked as its JSON object closes (SentenceStream) ──▶ emit sentence
    whole reply checked again ──▶ record_answer (service role) ──▶ questions + model_calls + question.ask ──▶ emit done
  NDJSON, one AskEvent a line; lib/ask-state.ts is the page's reducer.

"Suggest an edit" / "Suggest label fixes" ──▶ POST /api/suggestions
  suggestProtocolEdit / suggestLabels (lib/suggest.ts) ──▶ model ──▶ checked ──▶ record_suggestion (service role): open rows only
/suggestions/<id> ──▶ Approve ──▶ approve_protocol_suggestion ──▶ save_protocol as the member ──▶ settle_suggestion
                  ──▶ Edit first ──▶ the same call with the member's title, body and note
                  ──▶ Approve (labels, chosen files) ──▶ approve_label_suggestion ──▶ correct_label per file ──▶ settle_suggestion
                  ──▶ Dismiss ──▶ dismiss_suggestion
```

- **Checking citations** (`checkSentence`, `checkAnswer` in `lib/answers.ts`): a citation must name a source key the model was shown (`F1`… files, `P1`… protocols); a cell must be one of the cells it was shown (`Table!C4`), or the file citation stands without it. A sentence left with no citation is dropped; an answer left with no sentence is "not found", and the page lists the closest files.
- **Where citations go**: a file opens where Search would open it (`openTarget`, or the in-app row for a local folder), a cell opens the file's table in the chart builder, a protocol opens at the cited version (`citationHref`).
- **Who writes**: the model's output reaches the database only through `record_answer`, `record_suggestion` and `record_spend`, granted to the service role alone and called through `serviceAnswerWriter` (`lib/ask-db.ts`), which can't name anything else. They check the asker is a member of a live lab and insert `questions`, `suggestions`, `suggestion_labels`, `model_calls` and audit rows. Approving is invoker: the version or the corrections are the member's own, through the same triggers as any save, and `settle_suggestion` (definer) marks the suggestion approved only when it finds them, made by the caller in this transaction. A save since the fork fails approval with `BL101` and the suggestion stays open. `BL601` is a suggestion already decided, `BL602` a file not in it, `BL603` a file that isn't a labeled file in the lab.
- **Audit**: `question.ask`, `suggestion.create`, `suggestion.approve`, `suggestion.dismiss`, plus the `protocol.save` the approval makes.
- Tests: `apps/web/src/lib/__tests__/answers.test.ts` (citation checks, streaming, cache key, cap, diff), `ask.db.test.ts` (RLS, ledger, cache, cap, grants, approve, edit then approve, stale, dismiss, labels), with `pg-ask.ts` standing in for Supabase and `fake-model.ts` for the model. `scripts/eval-ask.sh` is the measured run. Fixtures: `/dev/fixtures/ask?view=answer|no-answer|limit|unavailable|home&q=…` and `/dev/fixtures/suggestions?view=protocol|labels|approved|stale|list`.
