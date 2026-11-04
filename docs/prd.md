# Binary Labs — Product Requirements

Nov 4, 2026 · @amani bobo

## Summary

Binary Labs is one private system for one research lab: it keeps everything the lab produces, finds it in seconds, and teaches new people from the lab's own work. The first build is a read-only search-and-label layer over the lab's existing Dropbox and Excel files, tested free with one protein biophysics lab for a month.

- **Who it's for:** academic wet labs first (PI, grad students, postdocs, new students); small biotech teams later, once interviews confirm the same problems.
- **Pitch:** "An assistant that remembers everything your lab has done."
- **Status:** product vision deck and landing page drafted; interviews with two PhD students; pilot lab not yet confirmed with its PI.
- **Working name:** Binary Labs (the deck still says Ternary; pick one before outreach).

## Problem and evidence

Labs lose results and repeat experiments, and every new person relearns procedures from scratch. Two PhD students in protein biophysics described the same three problems.

| Problem | What we heard | Cost to the lab |
| --- | --- | --- |
| Lost or untrusted data | Asked if the lab repeats experiments because earlier data couldn't be found or trusted: "Absolutely, it does. It does quite a lot." | Reagents, instrument time and weeks of student work spent re-running |
| Slow onboarding | "…the learning curve for the new people was steep…" The last postdoc was asked to record tutorials on almost everything before leaving. | Know-how leaves with people; seniors spend hours re-teaching |
| Unchecked runs | No interview quote yet; this comes from the deck's flag idea (protocol expected values vs. the day's controls) | Bad runs are found late, after downstream work is built on them |

Files today are spread across Dropbox folders, Excel sheets, instrument PCs and flash drives, with names like `IMG_4821.jpg` and `final_v2_REAL.xlsx`.

**Evidence gap:** two interviews in one lab type. Before building past Phase 1, talk to at least 8 more people across 4+ labs, including at least 2 PIs and 1 lab manager.

## Users and personas

The grad student is the daily user; the PI is the buyer and gatekeeper, since connecting the lab's Dropbox needs the PI's permission.

| Persona | Role in the sale | Main job | What they need from us |
| --- | --- | --- | --- |
| PI | Approves access, later pays | Keep results reproducible, keep the lab productive as people turn over | Read-only access, nothing moved, clear privacy story, 20 minutes of their time at most |
| Grad student / postdoc | Daily user, champion | Find past results, run experiments, train juniors | Fast search, phone upload at the bench, labels that are right most of the time |
| New student / rotation student | Learner | Get productive without asking seniors for everything | Protocol pages, videos, past runs of the same experiment |
| Lab manager (where one exists) | Admin | Ordering, instruments, onboarding, file hygiene | Member access, folder setup, instrument uploader install |

Permissions: PI and lab manager are **admins** (connect sources, invite, delete); everyone else is a **member** (search, upload, correct labels, review flags).

## Goals, non-goals and success metrics

The pilot passes on use, not interest: the lab searches every week for a month, a new person learns a procedure with it, and the PI names a price.

**Goals for the pilot**

1. Index one lab's Dropbox folder read-only and label every file with date, experiment and person.
2. Answer "where is X" questions in under 10 seconds, with every answer linked to the real file.
3. Hold the lab's protocols and tutorials in one place a new student can follow.

**Non-goals for the pilot**

- Writing to, moving or renaming the lab's files.
- Instrument connection, charts, flags and the lab drive (Phases 3–5).
- Sharing data between labs, or the opt-in data program (needs consent, university and funder rules, and a lawyer first).
- Replacing Prism, Origin or an electronic lab notebook.

**Success metrics**

| Metric | Target | How we measure |
| --- | --- | --- |
| Weekly active searchers | 3+ people, 4 weeks in a row | Distinct users with 1+ search per week (PostHog) |
| Search success | 70%+ of searches end in a file opened | Search → open events |
| Label accuracy | 80%+ of suggested labels accepted without edits | Accepted vs. corrected labels |
| Time to first value | Under 1 day from Dropbox connect to first search | Connect time vs. first search time |
| Onboarding | 1 new person learns a procedure using it | Ask the student and the PI |
| Willingness to pay | PI names a price per month | End-of-pilot interview |

## Product scope by phase

Build in the order labs said hurts most: finding things first, then capturing and teaching, then instruments, then checks. Only Phase 1 is in the pilot.

| Phase | Features | Done when |
| --- | --- | --- |
| 1. Find (pilot) | Read-only Dropbox connect; scan and extract text, tables and image content; suggested clean name + tags (date, experiment, person, instrument); duplicate detection by content hash; hybrid search with file previews; label correction that the system remembers; protocol and tutorial pages | 1 lab's folder fully indexed; 80%+ labels accepted; search answers cite the exact file |
| 2. Capture | Phone PWA upload with camera; screenshot upload from desktop; voice talk-through → written steps; video of a procedure linked to its protocol; our own storage starts here (content-addressed shards on R2) | A student can upload a gel photo at the bench and find it labeled the same day |
| 3. Connect | Instrument uploader for Windows PCs (watch folder, resumable upload); parsers for the pilot lab's top 5 instrument formats; data sheet → chart with editable labels, colors and axes | New instrument files appear labeled with no manual step |
| 4. Check | Protocol expected values (e.g. R² ≥ 0.98, peak at a given wavelength); flags against protocols and the day's controls, each citing its source; Q&A over the lab's records; AI suggestions run in a forked copy and wait for approval | Flags are 90%+ "useful" per lab feedback; zero flags without a cited source |
| 5. Lab drive | Mounted drive or web view showing all files under clean names, organized by date, experiment and person; full version history and point-in-time views | Lab chooses to save new files there instead of Dropbox |

Each phase starts only after the previous phase's "done when" holds in a real lab.

## Core user flows

The first five flows are the pilot; the last two come in Phases 2 and 4.

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

**6. Upload from the bench (Phase 2)**

1. Student opens the web app on a phone and takes a photo of a gel or notebook page.
2. Picks the experiment from recent ones or types it; the date and person fill in automatically.
3. The photo is labeled and searchable within a minute.

**7. Review a flag (Phase 4)**

1. A new result is checked against its protocol's expected values and the day's controls.
2. If it's outside range, the student sees the flag with the value, the expected range and the cited protocol version.
3. Student marks it "useful", "wrong" or "known issue"; the answer tunes future flags.

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

Dashed sources come after the pilot; the lab's original files never leave Dropbox in Phase 1, only extracted text and previews are stored.

## Data model

A file's identity is its content hash, not its name or path, so a citation still works after a file is renamed or moved and duplicates collapse into one record. Every table carries `lab_id`, and row-level security keeps each lab's rows to that lab.

| Table | Key fields | Purpose |
| --- | --- | --- |
| `labs` | id, name, plan | One row per lab (the tenant) |
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

Trust is the product: a PI will only connect the lab's Dropbox if access is read-only, the lab's data is walled off from every other lab, and nothing is used to train models.

- **Read-only by design:** the Dropbox app requests read scopes only; the code has no write path to the lab's files.
- **Lab isolation:** every row carries `lab_id`; Postgres row-level security enforces it; storage keys are prefixed per lab; tests check that one lab can never read another's rows.
- **Secrets:** Dropbox tokens encrypted at rest; disconnect deletes the token and stops sync at once.
- **Model providers:** use API terms where inputs aren't used for training; send only the extracted content each step needs, never whole folders.
- **Deletion:** a lab can delete everything we hold (index, previews, labels) in one action, done within 7 days, with a confirmation email.
- **Audit log:** every view, search, export and admin action is recorded and visible to admins.
- **Data we don't take:** no patient data or human-subjects data in the pilot; the pilot agreement says so, and the scan skips folders the PI excludes.
- **University rules:** some universities restrict where research data may be stored; ask the pilot lab's IT or research office before connecting.
- **Opt-in data program:** not in the pilot; needs consent, university and funder rules, and a lawyer before anyone is asked.

Write a one-page data agreement for the pilot, plain language, signed by the PI.

## Build plan

The Phase 1 MVP takes about 10 weeks with 2–3 builders, putting the pilot start around January 18, 2027 and the go/no-go review around February 15. Dates are proposed, starting the week of November 9; weeks 7–8 fall over the holidays, so expect half speed there.

&#91;embedded content: build plan · 5 milestones, pilot, 2 gates\]

Phases 2–4 get their own plans only after the February review; their order and "done when" checks are in Product scope above.

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

The biggest real cost is founder time: 2–3 people for about 10 weeks to the pilot.

## Risks and open questions

The biggest risk is that labs say yes to the idea but don't search every week; the pilot is designed to find that out within a month.

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Lab doesn't use it weekly | Medium | Weekly check-in with the champion; ship fixes within days; measure from day 1 |
| PI or university says no to connecting Dropbox | Medium | Read-only scope, one folder, one-page data agreement; offer a manual upload trial as fallback |
| Labels wrong too often | Medium | Hand-score the first 200 files; Needs a look queue instead of guessing; learn from corrections |
| Instrument formats are many and proprietary | High (Phase 3) | Start with the pilot lab's top 5 formats; treat unknown ones as files with metadata only |
| Model costs grow with images and PDFs | Low–medium | Tiers, caching by hash, small model first |
| Overlap with electronic lab notebooks (Benchling, LabArchives) | Medium | Position as the layer over the files labs already have; ask in interviews what ELN they use |
| Team time (school + internships) | High | Scope the pilot to Phase 1 only; cut anything that isn't search, labels or protocols |

**Open questions**

- [ ] Name: Binary Labs or Ternary? Check trademark and domain.
- [ ] Does the pilot lab use a personal Dropbox, a team space, or a university Dropbox? This changes the auth flow.
- [ ] Which university rules apply to storing research data with an outside service?
- [ ] What electronic lab notebook, if any, does the pilot lab use?
- [ ] What are the lab's top 5 instrument file formats?
- [ ] Would a PI pay from a grant, a department, or personally? What price did they name?
- [ ] Do small biotech teams have the same problems? Interview 5 before planning paid plans.
