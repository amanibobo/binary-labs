# Binary product requirements

Nov 4, 2026, updated Nov 20, 2026 · @amani bobo

## Summary

Binary turns a research lab's real experiments, the ones that worked and the ones that failed, into verified records that AI teams can use to train and test models. It sits on a lab memory that already works. Binary reads the lab's Dropbox read-only, labels every file, finds anything in seconds, and keeps the lab's protocols. The pilot is judged on whether one real lab's runs can become complete task folders that an AI team could use.

- **Who it's for.** Academic wet labs use Binary every day for search, protocols and run records. AI teams are the later buyers of the exported tasks. There is no buyer yet.
- **Pitch to a lab.** "An assistant that remembers everything your lab has done, including what went wrong."
- **What leaves the lab.** Binary may export de-identified run data for model training, and only when the lab has agreed and that run's own share switch is on. A lawyer reviews the data agreement before any real lab or real data. Until then Binary runs only on demo data, marked Sample.
- **Status on Nov 20.** The lab memory is built and runs on a demo lab. The run record's foundation is built, and its first four slices are being built: failure fields, raw files with planned versus actual, consent, and the voice debrief. No pilot lab is confirmed, and no real lab data has been loaded.
- **Name.** The product is Binary (decisions.md, "the product is called Binary"). The repo keeps the name binary-labs.

## Problem and evidence

Labs lose results and repeat experiments, and every new person relearns procedures from scratch. Two PhD students in protein biophysics described the same three problems.

| Problem | What we heard | Cost to the lab |
| --- | --- | --- |
| Lost or untrusted data | Asked if the lab repeats experiments because earlier data couldn't be found or trusted: "Absolutely, it does. It does quite a lot." | Reagents, instrument time and weeks of student work spent re-running |
| Slow onboarding | "…the learning curve for the new people was steep…" The last postdoc was asked to record tutorials on almost everything before leaving. | Know-how leaves with people; seniors spend hours re-teaching |
| Unchecked runs | No interview quote yet; this comes from the deck's flag idea (protocol expected values vs. the day's controls) | Bad runs are found late, after downstream work is built on them |

Files today are spread across Dropbox folders, Excel sheets, instrument PCs and flash drives, with names like `IMG_4821.jpg` and `final_v2_REAL.xlsx`.

**Evidence gap:** two interviews in one lab type. Talk to at least 8 more people across 4+ labs, including at least 2 PIs and 1 lab manager. The data program has no evidence yet either. No lab has been asked whether it would share its failed runs, and no AI team has said it would buy them.

## Users and personas

The grad student is the daily user. The PI is the gatekeeper twice over: connecting the lab's Dropbox needs the PI's permission, and so does sharing any run.

| Persona | Role in the sale | Main job | What they need from us |
| --- | --- | --- | --- |
| PI | Approves access and sharing, later pays | Keep results reproducible, keep the lab productive as people turn over | Read-only access, nothing moved, sharing off until the lab agrees, a plain data agreement, 20 minutes of their time at most |
| Grad student / postdoc | Daily user, champion, records runs | Find past results, run experiments, train juniors | Fast search, phone upload at the bench, labels that are right most of the time, a failed-run record that takes minutes |
| New student / rotation student | Learner | Get productive without asking seniors for everything | Protocol pages, videos, past runs of the same experiment, including the ones that failed |
| Lab manager (where one exists) | Admin | Ordering, instruments, onboarding, file hygiene | Member access, folder setup, instrument uploader install |
| AI team | Later buyer of task data; none yet | Train and test models on real lab work | Tasks with evidence, a confirmed answer, a rubric and provenance for every claim |

Permissions: PI and lab manager are **admins** (connect sources, invite, delete, agree to sharing for the lab); everyone else is a **member** (search, upload, correct labels, review flags, record runs). A run's share switch belongs to the person who ran it or an admin.

## Goals, non-goals and success metrics

The pilot passes when one real lab's failed runs become complete task folders, recorded by the people who ran them, confirmed by a named scientist, and shared only with the lab's agreement.

**Goals for the pilot**

1. Record each run with how it went. For a failed run, record the suspected cause, the confirmed cause, and who confirmed it and how.
2. Keep each run's original files linked and unchanged, and show what changed between the protocol as written and as run.
3. Let a scientist finish a failed-run record by voice or by typing in about 5 minutes. The 5 minutes is an estimate until a real scientist times it.
4. Export a run as a task folder only when the lab has agreed and the run's switch is on, with names and excluded fields removed.
5. Keep search, labels and protocols good enough that the lab opens Binary every week. The run records come from that use.

**Non-goals for the pilot**

- Writing to, moving or renaming the lab's files.
- New connector features. Charts, instrument integrations, the calendar, the map and the lab drive stay as they are.
- Any real lab or real data before a lawyer reviews the data agreement.
- Exporting a run without both consent switches on, or from a demo lab.
- A task format for a particular buyer. The task folder keeps its current design until a buyer asks for a change.
- Failure types beyond the draft list. New ones come from interviews with working scientists.
- Sharing data between labs.
- Replacing Prism, Origin or an electronic lab notebook.

**Success metrics**

The targets are starting guesses. Revisit them after the pilot's first two weeks.

| Metric | Target | How we measure |
| --- | --- | --- |
| Confirmed failed runs | 10+ in the month, each confirmed by a named scientist with their own tap | Runs with a confirmed cause and `confirmer_attested_at` set |
| Time to record a failed run | Under 5 minutes at the median | Debrief start to approval, timed with a real scientist; fixture times don't count |
| Runs shared | The lab signs the lawyer-reviewed agreement; 5+ runs have their switch on | The lab's agreement and the runs' switches, from the sharing log |
| Complete task folders | 5+ shared runs export with all eight parts | Each folder has evidence, protocol as run, context, question, answer key, rubric, review notes and provenance |
| De-identification | No personal name or excluded field in any exported folder | A person reads every folder before it leaves |
| Blocked exports | Every export attempt with a switch off is refused and logged | Export attempts against the sharing log |
| Model check | Each task shows how many models solved it | Runs once someone adds API keys |
| Weekly use | 3+ people search or record runs, 4 weeks in a row | Distinct users per week (PostHog) |
| Willingness to share | The PI shares some runs and says what would make them share more | End-of-pilot interview |

## Product scope

The lab memory is built. The data program is the work now, in the order of the cofounder's brief: failure fields and raw files first, then planned versus actual, consent and the voice debrief, then de-identification, the task export and the model check.

**What exists**

| Area | What it does | From now on |
| --- | --- | --- |
| Find | Read-only Dropbox connect; scan and extract text, tables and image content; clean names and labels; duplicates by content hash; hybrid search with previews; asking the lab, with cited answers; label corrections that Binary remembers; Needs a look | Kept working |
| Protocols | Protocol and tutorial pages with versions, talk-throughs recorded at the bench, procedure videos and steps drafted from them | Kept working |
| Capture | Upload from a phone or a desktop | Kept working |
| Checks | Expected values on a protocol, and flags against them and the day's controls, each citing its source | Kept working |
| Charts | Data sheet to chart, charts of repeats with fits and tests, a check's history across runs | Frozen |
| Instruments | The Windows instrument uploader | Frozen |
| Calendar | The lab's shared calendar, with repeats, reminders and a feed | Frozen |
| Map | A map of how the lab's work connects | Frozen |
| Lab drive | Every file under a clean name, with its version history | Frozen |

Frozen means bugs get fixed and nothing is added. There are no new connector features. The sections below still name the first plan's phases: Phase 1 is Find, Phase 2 Capture, Phase 3 charts and instruments, Phase 4 Checks and asking the lab, and Phase 5 the lab drive. All five are built.

**The data program**

| Step | What it adds | Done when |
| --- | --- | --- |
| 0. The run record | A run as its own record: its files with a role each, worked, failed or odd, retry links, a log of every change, and the consent rule checked in the database | Built Nov 19 |
| 1. Failure fields | Suspected and confirmed cause, who confirmed it and how, the earlier run it retries, a failure type from a fixed draft list | A failed run saves with a confirmed cause and a named confirmer, and runs filter by failure type |
| 2. Raw files | The original files, kept exactly as they arrived and linked to the run | Any run opens its original files unchanged |
| 3. Planned versus actual | The protocol as written, the version actually run, and the differences | A run shows a clear list of what changed from the plan |
| 4. Consent | A share switch on each run, off by default; the lab's agreement; a log of who changed each and when | An export attempt on a run with either switch off is blocked and logged |
| 5. Voice debrief | Six fixed questions when a run fails, answered by voice or by typing; a draft record beside the transcript; anything not said marked missing | A scientist finishes a failed-run record in under 5 minutes, and a typed option exists |
| 6. De-identification | Names, sample IDs tied to people, and fields the lab marks as excluded, all stripped before export | An exported record contains no personal names or excluded fields |
| 7. Task export | One folder per task: evidence, protocol as run, context, question, answer key, rubric, the second scientist's review notes, provenance | One real run exports as a complete task folder |
| 8. Model check | A few frontier models try each task; the tasks they fail are kept | Each task shows how many models solved it |

Steps 1 to 5 are being built together, as slices A to D in decisions.md ("the run record: foundation"). Steps 6 to 8 start after them. Later: a search for similar failures, failure types from real interviews, a buyer's format, and folder watching.

## Core user flows

Flows 1 to 7 are built. Flows 8 and 9 are the data program.

**1. Connect the lab (admin, once)**

1. PI or lab manager signs in and creates the lab.
2. Clicks Connect Dropbox, approves read-only access, and picks one folder.
3. Sees a progress bar as files are listed and scanned; can invite members by email meanwhile.
4. Gets an email when the first pass is done.

**2. Scan and label (system, in the background)**

1. List every file with its Dropbox id, path, size and modified time; hash its content.
2. Group exact duplicates by hash into one record with all locations.
3. Extract what's inside: text, table headers, image content, instrument metadata.
4. Suggest a clean name and tags; store a confidence score.
5. Low-confidence files go to a "Needs a look" queue instead of being guessed.

**3. Search**

1. Member types a question ("P450 gels from batch 3") or filters by date, person, experiment or file type.
2. Results show the clean name, the original name and path, a preview, and why it matched.
3. Clicking opens the preview, with a button to open the original in Dropbox.

**4. Correct a label**

1. Member edits the suggested name or a tag on any file.
2. The system saves the correction and applies the pattern to similar files (same folder, same naming habit), as suggestions.
3. The correction is logged with who made it and when.

**5. Needs a look**

1. Files the system can't read or isn't sure about wait in a queue.
2. A member says what the file is in one line; the system remembers it for files like it.

**6. Upload from the bench**

1. Student opens the web app on a phone and takes a photo of a gel or notebook page.
2. Picks the experiment from recent ones or types it; the date and person fill in automatically.
3. The photo is labeled and searchable within a minute.

**7. Review a flag**

1. A new result is checked against its protocol's expected values and the day's controls.
2. If it's outside range, the student sees the flag with the value, the expected range and the cited protocol version.
3. Student marks it "useful", "wrong" or "known issue"; the answer tunes future flags.

**8. Record a failed run**

1. A member picks the files from one attempt and makes a run, or opens a run that already exists.
2. They mark it failed. Binary asks six fixed questions, and the member answers each by voice or by typing.
3. Binary drafts the record from the answers and shows the transcript beside it. Anything the member didn't say is marked missing. Binary never fills in a cause nobody stated.
4. The member approves the record. A colleague can name who confirmed the cause, but the confirmer confirms it with their own tap.

**9. Share a run and export it**

1. A lab admin agrees for the lab, once the lawyer-reviewed agreement is signed. Binary stores which version of the agreement text they agreed to.
2. The person who ran a run, or an admin, turns on its share switch.
3. The export strips names and excluded fields, then builds the task folder. The database refuses the export and logs the attempt if either switch is off, if the confirmer hasn't confirmed the cause, or if the lab is a demo lab.
4. If someone turns a switch off after an export, Binary removes anything still in its storage. Copies already sent can't be pulled back, and the screen says so.

## Design and UX

The app should feel calm and fast: search is the home screen, every action responds in under a second, and nothing waits on the AI without showing progress.

**Principles**

- **Search first:** the home page is one search box with recent files under it; ⌘K opens search from anywhere.
- **Show the real file:** every result and answer shows a preview plus the original name and path.
- **Never block on AI:** labels appear as they're ready; skeleton loaders, not spinners; edits apply at once with undo.
- **Few clicks:** correcting a label is click, type, Enter.
- **Built for the bench:** phone capture works one-handed, touch targets 44 px or larger, fine on slow Wi-Fi.
- **Calm by default:** one accent per screen, generous white space, no badges or alerts unless a person needs to act.

**Visual system:** greens lead, blues support, amber is reserved for flags. Light and dark modes from day one.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| Ground | `#F7F8F6` | `#0F1E21` | Page background |
| Surface | `#FFFFFF` | `#16292D` | Cards, panels, previews |
| Ink | `#142529` | `#E8EFEE` | Main text |
| Muted ink | `#4A5A5C` | `#A9BDBD` | Paths, dates, secondary text |
| Green (primary) | `#1F6B5C` | `#4FC1A8` | Primary buttons, links, selected items |
| Blue (secondary) | `#2563A6` | `#7CC4F0` | Search match highlights, info, focus rings |
| Amber (flags only) | `#8A5E12` | `#E8B04B` | Flags and "check this" labels |

Type: DM Sans for the interface, JetBrains Mono for file names and values, matching the landing page. Corners 10–12 px, 1 px hairline borders, no heavy shadows or gradients. Check every text color pair at 4.5:1 contrast or better.

**Motion**

- 150–220 ms ease-out transitions for panels, previews and list changes (Motion library).
- Results update as you type (about 150 ms debounce) and the list stays steady instead of flashing.
- Turn animations off when the device asks for reduced motion.

**Onboarding with Frigade**

1. Admin checklist on first sign-in: connect Dropbox → invite members → run a first search → add a protocol.
2. Member tour, 4 steps: the search box, a result's preview and original file, correcting a label, the Needs a look queue.
3. Contextual hints the first time a "check this" label appears and on the first phone upload.
4. Checklist completion is tracked as the pilot's time-to-first-value metric.

Frigade's React SDK ([`@frigade/react`](https://www.npmjs.com/package/@frigade/react)) ships unstyled components under the Elastic License 2.0, so tours can use our colors and type. It's a hosted service; confirm its plan and pricing before the pilot.

**Quality bar**

- Keyword search results in under 300 ms at the median; clicks respond in under 200 ms (INP).
- Works at phone width; core flows pass keyboard-only and screen reader checks.
- Watch 3 students use it on real files before the pilot; fix anything that confuses 2 of them.

## System architecture

Files enter through one ingest layer, pass through three tiers of reading, and land in Postgres as labels and search rows that the web app serves. The pilot uses only the solid parts.

&#91;embedded content: system architecture · sources to search\]

Binary keeps its own copy of every file it reads, so a run's original files still open after they change or leave the lab's Dropbox. Binary never writes to the lab's Dropbox.

## Data model

A file's identity is its content hash, not its name or path, so a citation still works after a file is renamed or moved and duplicates collapse into one record. Every table carries `lab_id`, and row-level security keeps each lab's rows to that lab.

| Table | Key fields | Purpose |
| --- | --- | --- |
| `labs` | id, name, plan, sharing\_agreed\_at, sharing\_agreement | One row per lab (the tenant). `plan = 'demo'` marks a demo lab, whose data is made up: the app marks it Sample, and it can never export |
| `members` | lab\_id, user\_id, role (admin / member) | Who can see and do what |
| `sources` | lab\_id, kind (dropbox, upload, instrument), token (encrypted), cursor, root\_path | A connected folder and its sync cursor |
| `blobs` | sha256, size, mime | One row per unique content; identity of a file |
| `file_locations` | lab\_id, sha256, source\_id, external\_id, path, original\_name, modified\_at, seen\_at | Where each blob lives; many per blob for duplicates |
| `versions` | lab\_id, logical\_file\_id, sha256, parent\_version\_id, created\_at | Edit history when the same file changes over time |
| `extractions` | sha256, kind (text, table, image\_caption, instrument\_meta), content, extractor, extractor\_version | What's inside a file; cached so nothing is read twice |
| `chunks` | lab\_id, sha256, text, embedding (vector), tsv (full text) | Search index rows |
| `labels` | lab\_id, sha256, clean\_name, date, experiment\_id, person\_id, instrument, tags, confidence, status (suggested / accepted / corrected), model | The overlay that renames without touching originals |
| `corrections` | lab\_id, label\_id, before, after, user\_id, rule\_learned | Human fixes, reused for similar files |
| `experiments` | lab\_id, name, aliases, protocol\_id | E.g. "P450 batch 3" |
| `people` | lab\_id, display\_name, aliases, member\_id | Names and initials as they appear in files |
| `protocols` | lab\_id, title, body, version, expected\_values (JSON) | Protocol pages, and Phase 4 check rules |
| `flags` | lab\_id, sha256, protocol\_version\_id, observed, expected, control\_ref, status | Phase 4 checks, each with its source |
| `audit_log` | lab\_id, actor, action, target, at | Every access, edit and export |
| `runs`, `run_files`, `run_log` | lab\_id, status (worked / failed / odd), causes, confirmer, share switch; each file's role; every change with its before and after | The run record (design.md, "The run record") |
| `task_exports` | lab\_id, run\_id, withdrawn\_at | Built task folders. The database refuses a row unless both switches are on and the lab isn't a demo lab |

**Phase 2 adds** `shards` (sha256 of a \~2 MiB content-defined chunk, size, refcount) and `manifests` (version\_id → ordered shard list), the Space-style store for files that come straight to us.

## Tech stack

Use TypeScript for the web app and Python for file workers, with one Postgres doing data, search and the job queue. That keeps the pilot to three moving parts a small team can run.

| Layer | Choice | Why |
| --- | --- | --- |
| Web app | Next.js (App Router) + TypeScript, Tailwind, shadcn/ui on Radix, hosted on Vercel | Fast to build; accessible components; one codebase for desktop and the phone PWA |
| Phone capture | Same app as a PWA with camera input | No app-store review; works at the bench (Phase 2) |
| API | Next.js route handlers + server actions on Vercel | No separate API server for the pilot |
| File workers | Python 3.12 (pandas, openpyxl, pdfplumber, Pillow, python-magic, instrument parsers) | Science file formats have Python libraries; TypeScript doesn't |
| Heavy jobs (OCR, transcription) | Local first: a GPU machine running the same Python worker, with faster-whisper or whisper.cpp for speech and PaddleOCR or Surya for OCR; Modal only as overflow | Workers pull jobs from the Postgres queue, so a desktop with a GPU joins with no open ports and $0 per job; Modal covers it when that machine is off |
| Local model (optional) | Ollama or vLLM serving a small open model for Tier 2 labeling on the same GPU machine | $0 per file and nothing leaves the machine; check its labels against the hosted small model first |
| Database | Postgres (Supabase or Neon) | Relational data, row-level security per lab, backups included |
| Search | Postgres full-text search + pgvector, results merged by rank | Hybrid keyword + meaning search with no extra search service |
| Job queue | Postgres queue (`SELECT … FOR UPDATE SKIP LOCKED`, e.g. Procrastinate for Python) | One fewer service; retries and backoff built in |
| Object storage | Cloudflare R2 | Previews and thumbnails in Phase 1; content-addressed shards from Phase 2; no egress fees |
| Auth | Supabase Auth (Google + email magic link); university SSO later | Ties into row-level security directly |
| Dropbox | Dropbox API, scoped app with read-only file scopes, `list_folder` cursors + webhooks | Incremental sync without re-listing; read-only by design |
| AI models | Tier 2: a small fast model (e.g. Claude Haiku) for labels and image reading; Tier 3: a large model (e.g. Claude Sonnet) for hard files and Q\&A; an embedding model for search; speech-to-text for talk-throughs (local, above) | Matches the deck's "AI only where it is needed" tiers |
| Onboarding | Frigade (`@frigade/react`): first-run checklist, product tours, contextual hints | Walks each new member to a first search without a call; completion feeds the pilot metrics |
| UI polish | Motion (Framer Motion) for transitions, cmdk for the ⌘K command palette, Sonner for toasts, TanStack Query for cached, instant data | Smooth, quick-feeling UI; see Design and UX |
| Instrument uploader | Rust single binary, Windows first (Phase 3) | Instrument PCs are often old Windows; no runtime to install; `fastcdc` crate for chunking |
| Hosting | Vercel (web app + API), Fly.io or Railway (always-on Python worker), local GPU machine + Modal overflow (heavy jobs) | Cheap at pilot scale; easy to move later |
| Observability | Sentry (errors), PostHog (product events for the pilot metrics) | The pilot is judged on usage data |

Keep model calls behind one internal interface, so models can be swapped as prices change.

## AI pipeline

Each file goes to the cheapest step that can handle it, and every result is cached by content hash so no file is read twice. Nothing the AI suggests changes a label until it passes a confidence bar or a person accepts it.

**Tier 1: rules and parsers (no AI cost)**

- Dates from file metadata, EXIF, names (`2026-10-14`, `141026`) and folder names.
- People from folder names and initials, matched against the `people` aliases.
- Instrument formats by extension and magic bytes; parse headers for instrument, method and run time.
- Excel and CSV: sheet names, header rows, units.

**Tier 2: small model, narrow jobs**

- Labeling: input = extracted text, Tier 1 facts, folder path, the lab's experiment list and recent corrections; output = strict JSON (`clean_name`, `date`, `experiment`, `person`, `instrument`, `tags`, `confidence`, `reason`).
- Images: describe gels, blots, plates and notebook pages; read any handwriting.
- Talk-throughs: speech-to-text, then turn the transcript into numbered steps.

**Tier 3: large model, hard cases only**

- Files with confidence under the bar after Tier 2, conflicting signals, or unknown formats.
- Q&A over the lab's records (Phase 4): retrieve, then answer with citations only.

**Search and answers**

1. Chunk extracted text (about 500 tokens) and embed it; keep full-text vectors beside it.
2. Run keyword and vector search together and merge with reciprocal rank fusion; apply label filters (date, person, experiment).
3. For a question, the model answers only from retrieved chunks and must cite the file for each claim; no citation, no claim.

**Confidence and approval**

| Confidence | What happens |
| --- | --- |
| 0.85 or higher | Label shown as suggested; searchable right away |
| 0.5 to 0.85 | Label shown with a "check this" marker |
| Under 0.5 | No label; file goes to Needs a look |

These thresholds are starting guesses; tune them on the pilot lab's first 200 files, scored by hand.

**Learning from corrections:** each correction becomes a few-shot example in the next labeling prompt for that lab, and simple patterns (a folder always means one experiment) become Tier 1 rules.

## Security, privacy and trust

Trust is the product. A PI will only connect the lab's Dropbox if access is read-only, the lab's data is walled off from every other lab, and nothing leaves the lab unless the lab has said yes.

- **Read-only by design:** the Dropbox app requests read scopes only; the code has no write path to the lab's files.
- **Lab isolation:** every row carries `lab_id`; Postgres row-level security enforces it; storage keys are prefixed per lab; tests check that one lab can never read another's rows.
- **Secrets:** Dropbox tokens encrypted at rest; disconnect deletes the token and stops sync at once.
- **Model providers:** the models that label, search and answer run under API terms where the provider doesn't train on our inputs, and each step sends only the extracted content it needs, never whole folders.
- **Export for model training:** Binary may export de-identified run data for model training and testing, and only when both of these are on: the lab's agreement (any lab admin can agree for the lab, and Binary stores which version of the agreement text they agreed to) and the run's own share switch (off by default; the person who ran it or an admin turns it on). The database checks both at every export, and a refused attempt is logged.
- **What an export holds:** names, sample IDs tied to people, and fields the lab marks as excluded are stripped first. A run's confirmed cause goes out only after the confirmer has confirmed it with their own tap. Any change to a shared run turns its sharing off, so what goes out is the run as the lab agreed to share it.
- **Turning sharing off:** Binary removes anything still in its storage and logs that copies already sent can't be pulled back. The screen says so in plain words.
- **A lawyer first:** a lawyer reviews the data agreement before any real lab or real data. Until then Binary runs only on demo data. A demo lab (`labs.plan = 'demo'`) is marked Sample everywhere its data shows, and the database refuses every export from it.
- **Deletion:** a lab can delete everything we hold (index, previews, labels) in one action, done within 7 days, with a confirmation email.
- **Audit log:** every view, search, export and admin action is recorded and visible to admins. Every change to sharing is in the run's log, with who made it and when.
- **Data we don't take:** no patient data or human-subjects data in the pilot; the pilot agreement says so, and the scan skips folders the PI excludes.
- **University and funder rules:** some universities restrict where research data may be stored, and some grants restrict who may receive it. Ask the pilot lab's IT or research office before connecting, and the lawyer before any run is shared.

Write one data agreement for the pilot in plain language, covering both the lab memory and the export. A lawyer reviews it and the PI signs it. The agreement and switch wording in the app is placeholder text marked as a draft until then.

## Build plan

The data program is built in the order in Product scope. The run record's foundation landed on Nov 19. Slices A to D (failure fields, raw files and planned versus actual, consent, and the voice debrief) are being built at the same time. De-identification, the task export and the model check start once A to D land, and the model check runs only once someone adds API keys.

There is no pilot date yet. The pilot starts after a lab's PI agrees and a lawyer has reviewed the data agreement. Until then every build is checked on the demo lab (`bl demo-lab`), whose data is made up and marked Sample.

## Costs

A pilot lab costs roughly $100–250 to index once and $50–80 a month to run, so a $100–200/month price per lab leaves room. These are approximate; check every vendor's current pricing before quoting a number to anyone.

Assumed pilot lab: 20,000 files (\~200 GB) in Dropbox, \~500 new files a month, 8 members.

| Item | One-time (first scan) | Monthly | Assumption |
| --- | --- | --- | --- |
| Tier 2 labeling + image reading | $60–150 | $3–8 | \~$0.003–0.008 per file with a small model; Tier 1 rules handle part of the files for free |
| Tier 3 hard cases | $20–60 | $5–15 | \~5% of files, \~$0.02–0.06 each |
| Embeddings | Under $5 | Under $1 | Text chunks only |
| Q&A (Phase 4) | — | $10–30 | \~10 questions a member a week |
| Postgres (Supabase Pro or Neon) | — | \~$25 | Shared across early labs |
| Web hosting (Vercel Pro) | — | \~$20 | Shared across early labs |
| Python workers (Fly.io or Railway) | — | $5–15 | One small always-on worker |
| Modal bursts (OCR, transcription) | $5–20 | $2–10 | Pay per second; $0 when the local GPU machine handles it |
| R2 storage, Phase 1 previews (\~2 GB) | — | $0 | Inside R2's free 10 GB |
| R2 storage, Phase 2+ owned files | — | \~$1.50 per 100 GB | $0.015/GB-month, no egress fees ([Cloudflare](https://developers.cloudflare.com/r2/pricing/index.md)) |

The biggest cost risk is reading images and PDFs with a large model; route them to the small model first and cache everything by content hash.

The biggest real cost is founder time. The lawyer's review of the data agreement is the next cost that isn't a vendor; get a quote before the pilot.

## Risks and open questions

The biggest risk is that a lab uses Binary but won't share its runs, or shares them without the confirmed causes that make a task worth anything. The pilot is designed to find that out within a month.

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Lab won't share runs | Medium | Sharing per run and off by default; a plain agreement a lawyer has read; the lab sees exactly what an export holds before anything leaves |
| Failed runs never get a confirmed cause | Medium | Ask the six questions when a run is marked failed; voice or typing; a colleague can name the confirmer, and the confirmer only taps to confirm |
| An export leaks a name or an excluded field | Medium | Strip before export; a person reads every folder before it leaves; demo labs can never export |
| No AI team buys the tasks | High | Keep the task folder as designed and change its format when a buyer asks; talk to AI teams during the pilot |
| A lawyer, university or funder says no to sharing | Medium | Ask before any real data; the lab memory still works for the lab without the export |
| Lab doesn't use it weekly | Medium | Weekly check-in with the champion; ship fixes within days; measure from day 1 |
| PI or university says no to connecting Dropbox | Medium | Read-only scope, one folder, one-page data agreement; offer a manual upload trial as fallback |
| Labels wrong too often | Medium | Hand-score the first 200 files; Needs a look queue instead of guessing; learn from corrections |
| Instrument formats are many and proprietary | High | Instrument integrations are frozen; unknown formats stay files with metadata only |
| Model costs grow with images and PDFs | Low–medium | Tiers, caching by hash, small model first |
| Overlap with electronic lab notebooks (Benchling, LabArchives) | Medium | Position as the layer over the files labs already have; ask in interviews what ELN they use |
| Team time (school + internships) | High | Freeze charts, instruments, the calendar, the map and the drive; build only the data program's steps, in order |

**Open questions**

- [ ] What does the lawyer need the data agreement to say, and what does the review cost?
- [ ] Who buys the tasks, and in what format? Talk to at least 3 AI teams.
- [ ] Which failure types do real scientists add to the draft list? Who signs the list off?
- [ ] Check the name Binary for trademark and domain.
- [ ] Does the pilot lab use a personal Dropbox, a team space, or a university Dropbox? This changes the auth flow.
- [ ] Which university rules apply to storing research data with an outside service?
- [ ] What electronic lab notebook, if any, does the pilot lab use?
- [ ] What are the lab's top 5 instrument file formats?
- [ ] Would a PI pay from a grant, a department, or personally? What price did they name?
- [ ] Do small biotech teams have the same problems? Interview 5 before planning paid plans.
