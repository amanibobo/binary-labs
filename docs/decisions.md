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

## 2026-11-04 — speech-to-text: ElevenLabs, with local Whisper as the alternative

Talk-throughs are transcribed by ElevenLabs speech-to-text (Scribe) by default; the operator has ElevenLabs credits. Local Whisper (faster-whisper) on our own machine is the second implementation behind the same interface, chosen by config, for a lab that wants audio never to leave our machine or once a GPU worker exists. The transcript is stored as an extraction, so it's cached and searchable like any other text; a model then turns it into numbered steps that a person reviews before they become a protocol version. Needs `ELEVENLABS_API_KEY` in `.env`.

## 2026-11-04 — uploads: the first slice

Phones and desktops upload into our store; videos wait for a later slice. Choices made while building it, beyond the entry above:

- **50 MB per file.** Phone photos run 2–12 MB and lab PDFs and screenshots less; the cap keeps one request finishable on bench Wi-Fi (about 80 s at 5 Mbps) and bounds the worker, which reads a whole file into memory. Video and audio are refused outright.
- **The web app records the location, the worker writes the blob.** `record_upload` inserts the `file_locations` row; the worker computes the file kind and MIME type from the bytes as it does for Dropbox files, so that logic stays in one place.
- **One location per content per lab.** `external_id` is the sha256, so a retried or repeated upload returns the first location and keeps the first sender and experiment.
- **No new job.** The web app still never enqueues: `record_upload` sets `scan_requested_at` on the upload source, and a scan of an upload source lists nothing and hands its pending locations to `process_location`. Uploads are labeled within about 30 s of arriving on a laptop worker.
- **The sender and their day are label facts.** The sender becomes a `people` row linked to their membership, named from their profile or email. The day is the sender's local date, so an evening upload isn't dated tomorrow.
- **Uploads browse under "Uploads", one folder per experiment.**
- **Uploaded files open from our store** through `/api/files/<location>`, inline only for types that can't run script, and each open is audited.
- **Installable without a service worker.** Chromium reports the app installable with the manifest alone, and nothing of a lab's is cached offline.
- **Env names stay** `PREVIEW_STORE` and `PREVIEW_DIR`, now meaning the object store; renaming them would touch every deployment for no behavior change.

Open: the route takes the file through our server. On a host with a small request limit (Vercel functions take 4.5 MB) uploads would need a presigned PUT straight to R2 instead. HEIC files upload but the worker can't render them yet, so they fail at the preview step; iOS usually hands the browser a JPEG.

## 2026-11-04 — talk-throughs: the first slice

A protocol or tutorial page, the protocol list and "New page" offer "Record a talk-through". The recording goes up through the upload route, the worker transcribes it and drafts steps, and the person reviews the draft beside the transcript before "Use these steps" opens the editor. Choices made while building it, beyond the speech-to-text entry above:

- **30 minutes per recording, 100 MB per audio file.** One procedure told aloud usually takes 2 to 15 minutes. At 64 kbps, 30 minutes is about 15 MB, which goes up in under 30 s on 5 Mbps bench Wi-Fi, and its transcript (about 4,500 words) is an easy draft for the model. The recorder stops by itself at the cap and warns two minutes before. 100 MB leaves room for a longer or less compressed voice memo picked from the phone. The 50 MB cap for photos and documents is unchanged.
- **Opus in WebM where the browser has it, AAC in MP4 on Safari.** WebM sniffs as video, so the recorder names its files `.weba` and the worker knows them by extension.
- **The upload route takes the recording.** An `x-upload-purpose: talk-through` header picks the audio cap and `record_talk_through`, which records the file like any upload (under `/Uploads/Talk-throughs/`) and starts the talk-through in the same transaction. Plain uploads still refuse audio.
- **Only talk-throughs are transcribed.** The worker transcribes a location that has a `talk_throughs` row, whatever its bytes sniff as. Audio in a lab's Dropbox, or sent as a plain upload, is indexed by name, so nobody pays to transcribe an archive by accident.
- **The transcript is an extraction**, keyed by the transcriber's name and version (`elevenlabs/scribe_v2`, `whisper/small`), chunked and embedded like any text. The same audio is never transcribed twice by the same transcriber, in any lab. Each transcription is a `model_calls` row (purpose `transcript`) with its seconds and cost: Scribe v2 is $0.22 an hour.
- **Steps come from Tier 2** (`claude-haiku-5-5`, medium effort), as the PRD places talk-throughs: rewording what someone said into steps is a narrow job, and a person checks every draft. The model returns strict JSON (title, materials, steps, cautions), told to use only what was said and to keep numbers as spoken; we write the Markdown, so the steps are always a numbered list and empty sections are left out. The answer is cached in `model_calls` (purpose `steps`).
- **A draft never applies itself.** It's stored on the talk-through. "Use these steps" saves through `use_talk_through`, which creates the page or saves on top of the version that was on screen while recording (so anyone's save since is caught, as in the editor), links the recording to the page and marks the talk-through used, all in one transaction. An existing page keeps its title.
- **Every state is visible.** Transcribing, drafting, ready, failed with Retry, or no draft (no model set up, no speech heard, or nothing like steps), which offers the transcript to start from instead. Without `ANTHROPIC_API_KEY` talk-throughs still transcribe and the transcript is the starting point.
- **Each paid job runs once at a time.** Transcription and drafting jobs carry procrastinate's execution lock as well as the queueing lock, so a rescan or the 10 s sweep can't start a second paid call beside a running one.

Measured: a 35 s spoken clip (`scripts/e2e-talk-through.sh`, real ElevenLabs and Claude on local Postgres) was transcribed and drafted 10 s after the worker started, for $0.0022 transcription and $0.0005 drafting. The audio's label adds $0.0003, or $0.006 when Haiku is unsure and Sonnet runs.

Open: the worker holds a database connection while it transcribes, which for 30 minutes of audio can take a few minutes. Local playback in dev serves the whole file without range requests, which Safari may refuse to play; R2 in the pilot answers ranges. A recording re-sent for another page returns the first talk-through.

## 2026-11-04 — settings: an overview of illustrated tiles

Settings opens on an overview instead of one tall column of cards. Each area is a tile drawn like the Browse folders: Dropbox (a cloud with two sheets behind it, blue; not the Dropbox logo), Experiments (a flask, green), People (a name badge, orange), Members (two people, purple) and Your account (a key, gray). Under each title sits one line of state: files indexed or "Disconnected", how many experiments or people, admins and members, your role. Deleting the lab is a quiet row under a rule, with a small gray bin, shown to admins only. Yellow is left out of the set so nothing near amber appears on the page.

A tile opens its area at `/lab?area=<area>`, a short page headed by the illustration, the area's name and one sentence of help, with a "Settings" link back. The Dropbox area is rows of label, value and the action that changes it (Account with Disconnect, Folder with Change folder, Files with Rescan). Experiments and People take a new entry in one row at the foot of the list, and Members show each person's role on the right. A Dropbox sign-in that returns with a notice opens the Dropbox area, and the "Connect Dropbox" and "Open settings" buttons on Search and Browse go straight there.

A two-column page (a section list on the left, every section stacked on the right with its illustration) was sketched and set aside: it kept the long scroll the old page had and its 28 px illustrations in the list read as blurs. The overview answers "what's here and is it working" at a glance and keeps each task to one short page. The drawings share their gradients and the paper sheet with the folders (`components/art/kit.tsx`); a sheet on the bare page gets a hairline edge so it shows on white.

## 2026-11-04 — procedure videos

A protocol or tutorial page has a Videos section above its files. "Add a video" records with the phone's camera, picks a video file, or links a video already in the lab's index; each plays in the page, with a poster, and search finds what's said in it. This finishes Phase 2's build order. Choices made while building it:

- **A video is a protocol file whose blob is a video.** Blobs get a `video` kind (0011 refiles videos indexed before it). An uploaded video waits in `pending_protocol_files` until the worker has read the stored bytes and hashed them; only then is it linked, as the person who added it, so the page's membership and archive checks run and the audit log names them. Nothing is linked by a sha256 nobody verified: extractions and transcripts are shared by hash, so a claimed hash could read another lab's text.
- **500 MB per video, sent straight to the store in 8 MiB parts.** Phones record 1080p at 100 to 200 MB a minute, so 500 MB is 3 to 5 minutes, enough for one technique. On 5 Mbps bench Wi-Fi it takes about 13 minutes to send; a dropped connection costs one part (about 13 s), retried after 2, 5 and 15 s and then on Retry or when the browser is back online. Storage doesn't set the cap: a video at the cap is $0.0075 a month at R2's $0.015/GB, and a lab with 100 of them holds 50 GB, about $0.75 a month, inside the PRD's line for owned files. Transfer time and the worker's memory set it. A longer video gets "trim it in Photos first".
- **The server stays the authority.** Starting checks the page and the cap and opens a multipart upload at `<lab_id>/uploads/<upload id>`, a staging key under the lab's prefix. Each part goes to a presigned R2 `UploadPart` URL with its size signed in, or, with the local store, to our own route. Completing joins the parts, checks the size, reads the object back and computes the sha256 on the server, copies it to `<lab_id>/files/<sha256>`, and only then calls `record_video`; the staged copy is dropped after that, so a complete that fails part way can run again. A part URL can't name a size over the cap, so one session stages at most 500 MB. Every key is built from the session's lab. Reading 500 MB back from R2 costs no egress and a few seconds on a hosted server. Parts live in the page's memory, so an upload survives dropped connections but not a reload, as the upload queue does.
- **Playback is an HTML video element on `/api/files/<location>`.** The local store answers byte ranges itself (206, `Content-Range`); R2 answers them behind a presigned redirect, which for a video lasts four hours because browsers send later ranges to the URL they were redirected to (other files keep the one-minute link). `video/mp4`, `video/quicktime` and `video/webm` are served inline with `nosniff`; anything else still downloads. A video asks for many ranges as it plays, so only the request that starts at byte 0 is audited as a download. No transcoding: a phone's HEVC MOV plays where the browser decodes HEVC (Safari, most Chrome on Mac and recent Windows).
- **A Dropbox video plays through a temporary link.** The server mints the lab's access token, calls `get_temporary_link` (covered by the `files.content.read` scope we already hold) and redirects to Dropbox's four-hour link; "Open in Dropbox" stays. It's feasible because it needs no new scope and the token never leaves the server, and fair because members already see every indexed file's preview and text. Only video types take this path; other Dropbox files still open in Dropbox.
- **Posters come from ffmpeg, an optional system dependency.** The worker takes the frame at 1 s (or the first frame of a shorter clip) as a 640 px WebP preview, stored like any other preview. Without ffmpeg, or for a frame it can't read, there's no poster and the file still indexes. There's no pure-Python fallback: nothing in pure Python decodes H.264 or HEVC, and PyAV would bring its own copy of ffmpeg's libraries. `FFMPEG_PATH` points at it when it isn't on `PATH`.
- **Only a video on a page is transcribed**, as only a talk-through is. Every 10 s the worker gives each video blob on a page a `videos` row and transcribes the waiting ones: ffmpeg takes the first audio track as mono 16 kHz AAC (about 22 MB an hour), the configured Transcriber hears it, and the transcript is an extraction keyed by the transcriber, chunked and embedded in that lab. The job is locked per video, and the extraction is cached, so two labs or pages linking the same video pay once; the lab whose copy was heard gets the `model_calls` row. States are waiting, ready, failed (Try again) and unavailable: no sound, a Dropbox video over 500 MB (it plays but isn't read whole into the worker), or no ffmpeg.
- **Deletion and isolation.** `videos` and `pending_protocol_files` are lab tables with RLS (members read them; members can take a pending video off a page), and `videos` is a blob reference. Staged parts, stored videos and posters all sit under `<lab_id>/`; deleting a lab in R2 also aborts open multipart uploads under the prefix, since parts aren't objects a listing finds.
- **Not built: "Draft steps from this video".** It would need a talk-through row on a location that wasn't recorded as one, drafting held until the video's transcript exists, and a talk-through page that plays video. That is more than a small step; the transcript on the page is the starting point for now. Recording in-app with `MediaRecorder` was also left out: the phone's own camera records better video.

Measured: a 14 s spoken clip (`scripts/e2e-video.sh`, 2.8 MB, real ElevenLabs on local Postgres and the local store) went up in one part, was linked with a poster, and was transcribed and searchable 6 s after the worker started, for $0.000853.

Open: the R2 path (multipart, presigned parts, read-back) and Dropbox temporary links are built against their APIs but untested against a live bucket and account; R2 needs a CORS rule that allows PUT from the app's origin and exposes `ETag`, and a lifecycle rule that aborts incomplete multipart uploads after a day, since the server keeps no list of open sessions and an abandoned one otherwise waits for lab deletion. The worker reads a whole video into memory, up to 500 MB, so a hosted worker needs room for it. Bytes moved to `<lab_id>/files/<sha256>` stay if `record_video` then refuses (an archived page), until the lab is deleted, as with uploads.

## 2026-11-04 — logo and a text-only landing page

The logo is a lowercase b drawn in squares with small gaps (a 4 by 6 grid); the bottom-left square is green and the one above it blue, the rest ink (light on dark grounds). One source, `apps/web/src/lib/logo.json`, feeds the app's top bar, the sign-in card, the SVG favicon and the home-screen icons; the landing keeps a copy in `apps/landing/app/logo.tsx`.

The landing page supersedes the heyclicky-style desktop hero: one column in the middle of the page with its text left-aligned. The logo beside a serif title, one sentence on what Binary Labs is, then "Request a pilot" (green), "Sign in" and "Book a call" as plain links, then a short mission section ("our mission") with a few phrases marked in green or blue highlighter that draw in when it scrolls into view. No app mock-ups, no screenshots.

## 2026-11-04 — a quiet left sidebar (supersedes "top bar instead of the sidebar")

The operator asked for a clean sidebar. On desktop a fixed 240 px column holds the logo with the lab name under it, a search field that opens the ⌘K palette, then Search, Browse, Protocols, Needs a look (its count muted on the right) and Upload, with Settings and the account (Sign out) pinned at the foot. Line icons in muted ink; the current page gets a soft fill. No folder tree this time: the first sidebar's tree with tinted folders and counts is what made it read as busy, and Browse already shows folders. Phones keep a slim top bar (logo, Upload, search, menu) and the menu opens the same column as a sheet. Breadcrumb bars take their page's column width so the crumbs sit over the title.

## 2026-11-04 — naming and copy rules

From the first signed-in walkthrough. One word for one thing, in the words a grad student uses:

- **Protocol** is the thing under Protocols ("New protocol", "Archive"), with Protocol or Tutorial as its kind; "page" is gone from buttons and empty states.
- **File** for anything in the lab, **upload** for what came through the app; never source, location, blob, extraction or tier.
- **Talk-through**, **Check this** and **Needs a look** stay: they name things a person acts on.
- Help text is one short sentence, or none when the screen says it already. An empty state says the next step in one line.
- Search rows show the clean name, one path line, the matching text and the label's facts (date, experiment, person, instrument); free tags and Add tag wait for the opened row. Word matches are highlighted, so only a meaning-only match says why ("Similar in meaning"). The opened row's main action is opening the real file.
- Dates of moments (saved, modified, joined, recorded) show the reader's own day; label dates are calendar days and never shift.
- Amber is only for Check this; audio files take the gray kind tint.

## 2026-11-04 — a calmer search screen

The box is the hero (no lab-name title, no blue focus ring) with example searches from recent labels under it, and filters sit behind one "Filters" control, showing only set filters as removable chips. Rows drop the card: a 64 px preview on the left (kind icon as fallback), the name, one meta line (path, the label's date or else the modified date), matching text only for a query, and experiment, person and instrument; Open shows on hover and focus. Right-hand thumbnails and a preview grid for recent files were tried and dropped: the first left a ragged column of icon tiles, the second broke the recency order and lost rename and Check this.

## 2026-11-05 — Phase 3 starts with the parts that don't need the pilot lab

Phase 3 (Connect) starts at the operator's call while Phases 1 and 2 wait for a real lab. The instrument parsers wait for the pilot lab's top five instruments; two pieces don't depend on them and start now.

**Instrument uploader.** A single Rust binary, Windows first, that watches one or more folders on an instrument PC and sends each new or changed file to the lab. A file is sent only once its size and modified time have held still and it can be opened, since instruments write files gradually. The binary hashes the file, asks the server whether the lab already has it, and otherwise sends it in parts through the same server-authorized multipart path videos use; the server verifies size and sha256 before recording it, and storage keys are built server-side. Progress survives restarts: the uploader keeps a small local queue of files and finished parts, so a reboot or a dropped network resumes rather than restarts. Content-defined shards (`fastcdc`) stay deferred until large files that change a little at a time show up; multipart covers resumable sends today. An admin adds an instrument in Settings and gets a one-time pairing code; the uploader trades it for a device token (stored hashed) that can only add files to that one instrument source in that lab, and the admin can revoke it. Files from an instrument go through the same index, label and search pipeline as everything else, with the instrument's name as a strong Tier 1 fact. The Windows `.exe` is built on a GitHub Actions Windows runner; development and tests run on macOS.

**Data sheet to chart.** From a spreadsheet or CSV in the lab, a person picks the columns and gets a chart (line, scatter or bar) whose title, axis labels, units, colors and series names they can edit; the chart is saved with the file, can be linked to a protocol, and exports as SVG and PNG. The worker stores the full parsed table for charting (extraction keeps only the first rows for search), cached by sha256. Charts never change the source file.

## 2026-11-05 — our own onboarding instead of Frigade

Supersedes the PRD's Frigade plan. Onboarding is built in the app, no third-party service: a welcome on first sign-in, a short spotlight tour of the screens, a getting-started checklist, one-time hints, and a help menu behind an ⓘ button in the sidebar that replays any of them and answers "How do I…" questions. Each tour step and help answer shows a short looping clip recorded from the real app (fixture data), silent, a few seconds long, small enough to load instantly, with a still poster when the person prefers reduced motion. Checklist items are worked out from what the lab has actually done (Dropbox connected, someone invited, a search run, a protocol added, a file uploaded) rather than ticked by hand, so they stay true; whether a person has seen or dismissed the tour and each hint is stored per user. Clean and quiet: one thing at a time, skippable at every step, never blocks the screen behind it for long, sentence case, no badges or confetti.

## 2026-11-05 — appearance: same as device, light or dark

Settings gains an Appearance area with three choices: same as device (the default), light, dark. The choice is saved in a cookie on that browser, not on the account, so a shared bench laptop and a personal phone can differ. A small script in the page head applies it to `<html data-theme>` before the first paint, so there's no flash of the wrong theme, and keeps following the device while "same as device" is chosen. The dark tokens now hang off `[data-theme="dark"]` instead of the media query, so they're defined once.

## 2026-11-05 — the product is called Binary

The product name is Binary, not Binary Labs: the app's titles, sidebar, phone bar, install name, emails and copy, the protocol export header, and the landing page. The lowercase square b stays as the mark. The repo, folders, package names, environment variable names and storage bucket keep their existing names; renaming them would break links and deployments for no one's benefit.

The desktop sidebar can fold to a 64px icon rail: each icon names itself in a tooltip on hover or focus, Needs a look shows a small dot when files wait, and the toggle (also ⌘\) is remembered per browser in a cookie so pages render at the right width with no shift.

## 2026-11-05 — data sheet to chart: the first slice

A spreadsheet or CSV's opened row (in search, Browse and a protocol's Files) offers "Make a chart" beside its other actions and lists the charts already made from it. The builder at `/charts/new?file=<location>` shows the file's table on the left (a sheet picker, then each column with its letter, unit and whether it holds numbers or text) and the live chart on the right, with its type, series, axes, legend and an optional protocol under it. A saved chart lives at `/charts/<id>`, and a protocol it names draws it in a Charts section under Videos. Choices made while building it:

- **Tables are parsed while a file is processed.** The bytes are in hand then, so a chart never waits for a second download, and the builder opens at once. A spreadsheet indexed before charts existed, or one whose table failed, is asked for when someone opens the builder (`request_data_table` sets it waiting) and the worker's 10 s `tend_tables` reads it again; the web app still never enqueues. On a laptop the three fixture exports were ready 3 s after the worker started, and a file asked for again 8 s after the ask.
- **One columnar JSON per file per lab**, at `<lab_id>/tables/<sha256>.json`, so deleting the lab's prefix removes it. `data_tables` records it by (lab, sha256) with the parser's version, and a ready table at the current version is never parsed again.
- **200,000 cells per file.** Measured on a 40,000-row, 9-column export of 3-decimal values: the worker kept the first 22,222 rows in 0.27 s, as 1.5 MB of JSON that gzips to 0.64 MB, about a second on 5 Mbps bench Wi-Fi. A 2 h kinetic read of a 96-well plate is 24k cells, a full spectrum scan of one 38k, an AKTA run with eight curves 48k. The budget is shared so small sheets stay whole and big ones split the rest; a cut table says "First 20,000 rows of 85,312." under the chart. Also 32 sheets, 512 columns and 200 characters a text cell.
- **What the parser reads.** The header is the first mostly-text row as wide as the table with data under it, so instrument preambles become notes shown above the columns. A second header row of units (AKTA's `ml`, `mAU`) or sub-names (`Rep 1`) joins the first, with a name written once covering the columns to its right. Units come from a trailing parenthesis or bracket. A column holding mostly numbers is a number column, and its odd cells (`OVRFLW`, `n/a`) are blanks counted as "not numbers". `h:mm:ss` reads as minutes, hours or seconds by its length. Decimal commas are read when the separator isn't a comma, UTF-16 files (UNICORN's exports) are decoded, merged cells are read from the sheet's XML and fill every cell they span, blank rows split one sheet into several tables, and a plate grid with a blank corner keeps its row letters.
- **Specs name columns by letter**, which stays put however a column is named. `chart_spec_ok` in SQL mirrors `ChartSpec` (zod); the save route also checks every column against the stored table, and refuses text on a number axis or more than 60 bars. Members create, edit and delete charts; each is a `chart.create`, `chart.save` or `chart.delete` in the audit log. A save names the `updated_at` it started from, so two people never overwrite each other silently.
- **Hand-rolled SVG, no chart library.** Linear and log ticks, lines, dots, bars, error bars, a legend, a hover readout and a table of the numbers come to about 950 lines (`chart-geometry.ts`, `chart-svg.tsx`, `chart-figure.tsx`); the builder's chunk, export included, is 39 KB minified and 13 KB gzipped. Recharts, visx and Plotly would each have cost more than that for features we don't use, and an exported SVG from our own markup is clean.
- **Six series colors.** The dataviz reference hues in the order blue, orange, aqua, violet, magenta, green, which passes its colorblind checks on our surfaces (worst neighbors 9.2 light and 9.4 dark, normal vision 19.7). Yellow is left out because amber means Check this, and red because it reads as an error and dropped the order's worst pair under the target. A scatter takes three series, the most its checks allow when any two dots can touch; lines and bars take six. Aqua and magenta sit under 3:1 on the light surface, so every chart has "Show the numbers" and a legend once it has two series.
- **Export is client side.** SVG and a PNG at twice 960 by 560, with the title on the figure, in the light colors on white, as a printed figure would be.

Not built: per-series x columns (AKTA curves exported each with its own volume column chart against one x, which is right when they're sampled together, as UV curves are), dates along x, a sweep that re-parses tables after a parser version bump (the next scan or ask does it), heatmaps of plate grids, and more than six series.

## 2026-11-05 — the instrument uploader

Built as the Phase 3 entry above describes. An admin adds an instrument in Settings > Instruments, reads off a pairing code, and runs `binary-labs-uploader pair <server> <code>` on the instrument PC; from then on new files in its watched folders show up under Browse at Instruments/<name>/. Choices made while building it:

- **One table, one source per instrument.** `instruments` holds the name, who added it, the pairing code's hash and expiry, the device token's hash, and when it paired, was last seen and was revoked. Each instrument gets its own `instrument` source, so a token's reach is one `source_id` and Browse, deletion and counts need nothing new. Members read instruments through `lab_instruments` and column grants that leave out both hashes, because an 8-character code is guessed from its sha256 in seconds.
- **Codes are 8 characters of Crockford base32**, shown as `K7QM-4XPA`, good once for 15 minutes; typed codes ignore case, spaces and dashes and read O as 0 and I or L as 1. An instrument pairs once. A code that ran out gets a new one; a PC that's reinstalled is revoked and added again, and its files land in the same Browse folder if it keeps its name. Ten wrong codes from one address in 15 minutes, or a thousand from everyone, stop pairing for a while.
- **Device tokens are `blu_` and 32 random bytes**, stored as their sha256 and handed only to the uploader. The uploader's routes live under `/api/instruments/`, which the session proxy skips, and read only `Authorization: Bearer`; session routes read only cookies, and a Supabase JWT never has the prefix. The database functions behind them (`pair_instrument`, `instrument_session`, `record_instrument_file`) take the token's hash and are granted only to the service role, so the database, not the route, decides which source a token writes to; pairing has no session, and its rate limit has to trust the address our server passes in.
- **Files go through the videos' multipart path, now shared** (`lib/staged-upload.ts`): start, a presigned part URL or our own part route, then complete joins the parts, reads them back, checks the size and the claimed sha256 on the server and only then copies them to `<lab_id>/files/<sha256>`. "Do you have this file?" answers yes when the lab's store already holds those verified bytes, from any path or an upload, and records the new path without a byte sent; it never looks across labs. A file's location keeps its path on the PC as `external_id` and its sha256 as `source_rev`, so an export the instrument rewrites in place is one file that is indexed again.
- **500 MB per file**, the same as videos. Instrument exports are KB to a few hundred MB; the worker still reads a whole file into memory, and an imaging stack bigger than that waits for content-defined shards. The uploader skips a bigger file and lists it in `status`.
- **The instrument is a Tier 1 fact at the strength of a person's correction**, not merely strong: the lab named the instrument that sent the file, which is surer than a SpectraMax signature in its header, so a header never conflicts with it. It stays on a Needs a look label too, since it isn't a guess.
- **The uploader is one Rust binary** (`instruments/uploader`, `ureq` with rustls, `notify`, `sha2`, no async runtime). A file is sent once its size and modified time have held for 10 s and, on Windows, it opens without a sharing violation; it is hashed streaming and re-checked after. Its queue and confirmed parts live in a JSON file written atomically after every part, so a reboot sends only the missing parts. It runs from Task Scheduler at the paired user's log on rather than as a Windows service: no service code or crate, `run` already rides out every transient error, and the task runs as the user whose settings hold the token. Settings live in `%LOCALAPPDATA%\Binary\uploader`, so roaming profiles don't copy the token.
- **Settings > Instruments** lists each instrument with when it last checked in and how many files it sent; an admin adds one, sees the code once with the four commands to run, and the panel turns to "Paired" by itself. The drawing is a gray benchtop reader with its plate drawer out, gray because the tiles beside it are already blue and green.

Measured: `scripts/e2e-instrument.sh` paired the real release binary with the real route handlers on local Postgres and a local store (only the database client swapped for plain Postgres), refused a wrong and a used code, and sent a CSV, a file written over 10 s and a 20 MB file. Killed after the 20 MB file's first part, the restarted uploader sent parts 2 and 3 only. The growing file was recorded 22 s after writing began, at its final size; a lock file and a `.tmp` file were never sent. The worker indexed and labeled all three with the instrument within 2 s.

Open: Windows-only behavior (the sharing-violation probe, hidden and system attributes, `notify` on NTFS, Task Scheduler's defaults) is built and type-checked but runs for the first time on the CI Windows runner and then a real instrument PC. The exe needs Windows 10 or later. There's no download page for it yet; the admin gets it from the CI artifact. R2's presigned part path is the videos' path, still untried against a live bucket.

## 2026-11-05 — onboarding: how it's built

Choices made while building "our own onboarding instead of Frigade":

- **What a person has seen lives in an `onboarding` table**, one row per user (0015), not in auth user metadata, which the user can rewrite from the browser and which RLS can't be tested against. Its policies keep each person to their own row; it cascades with the user and holds no lab content, so lab deletion has nothing to remove. `note_onboarding` records one event at a time and is safe to repeat: the welcome and a hint stay seen, the tour step only moves forward, a finished tour stays finished unless it's taken again.
- **The checklist is never stored.** `onboarding_progress` returns when each fact first became true: Dropbox connected with a folder, the lab's first upload, its second member (an invite creates the membership), its first protocol, and the caller's own first search (from `audit_log`), label fix and upload. It runs as definer because members can't read the audit log, and answers only for the caller in a lab they belong to. Admins get the PRD's list plus an upload: add your lab's files (Dropbox, or uploads alone), invite someone, run a search, add a protocol, upload a file. Members get take the tour, run a search, fix a label, upload a file. The latest of an admin's times, minus when they joined, is the pilot's time to first value.
- **The tour stays on the Search home.** Every step's anchor is there or in the sidebar, so it never navigates mid-tour; the help menu on another page goes to `/?tour=1`. Anchors are `data-tour` attributes; a sidebar anchor falls back to the phone's menu button, and a step with nothing on screen sits in the middle. Radix Popover (modal, so focus stays in it) places the step on a desktop; a phone gets a bottom sheet.
- **One thing at a time.** The welcome, a tour step, a hint and the help sheet share one overlay state, so a hint waits until nothing else is up and the anchor has sat on screen for a moment.
- **Clips are recorded by `scripts/record-clips.mjs`** from the fixture pages with Playwright's recordVideo, cropped to the task, at most 720 px wide, in H.264 and VP9 with a WebP poster, light and dark. They follow `<html data-theme>`; the server renders the dark set. With reduced motion only the poster shows.
- **Help is a row under Settings** with the ⓘ, like the other footer rows and named in a tooltip when the sidebar is folded.
