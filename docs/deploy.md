# Putting Binary online

This is the order to do it in, with a check after each step. Nothing here has been run against a real account yet; the last section lists what that leaves unproven. The choices behind it are in decisions.md, "going online: hosts and how they fit".

Where things end up:

| Piece | Host | Address |
|---|---|---|
| Landing page (`apps/landing`) | Vercel | `https://<domain>` |
| The app (`apps/web`) | Vercel | `https://app.<domain>` |
| Database and sign-in | Supabase (the existing `binarylabs` project, on Pro) | |
| Files, previews, videos | Cloudflare R2 (the existing bucket) | |
| Worker (`bl worker`) | Fly.io, one machine, no public address | |
| Search model (Qwen3-Embedding-0.6B) | Modal, one L4 GPU, off when idle | `https://<workspace>--binary-embed.modal.run` |
| Sign-in and invite email | Resend, as Supabase's mail server | |

`<domain>` is the domain you pick. Replace it everywhere below and in the three `.env.production.example` files.

## 0. Before you start

1. Run `scripts/predeploy-check.sh` from the repo root. It typechecks, lints and tests everything, builds both apps for production, checks the env templates against the code, and checks the worker's production dependencies leave torch out. It needs local Postgres 17, as the tests always have. It ends with "All checks passed."
2. Make one long random key for the embedding service. You'll paste the same value in three places:

   ```
   openssl rand -hex 24
   ```

   Call it the embed key below.
3. Keep `TOKEN_ENCRYPTION_KEY` from your current `.env`. The app and the worker both need that exact value; a new one would make the Dropbox tokens already stored unreadable.

## 1. Rotate the Supabase access token

`SUPABASE_ACCESS_TOKEN` is a personal token for the Supabase CLI. No deployed service uses it, but it has sat in `.env` files and agent sessions, and it can change every project on your account.

1. Supabase dashboard > your avatar > Account preferences > Access Tokens.
2. Revoke the current token.
3. Make a new one only if you still use the CLI, and keep it out of every project's environment variables.

Check: the old token is gone from the list.

## 2. Supabase: upgrade to Pro

Supabase > Organization > Billing > change the plan to Pro.

Why: free projects pause after a week without activity, which would take the app down between pilot visits, and they have no backups. Pro never pauses, keeps 7 days of daily backups, and includes 8 GB of disk and the Micro compute size ([pricing](https://supabase.com/pricing)).

Write down, from Project Settings > API: the project URL (`NEXT_PUBLIC_SUPABASE_URL`), the `anon` key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) and the `service_role` key (`SUPABASE_SERVICE_ROLE_KEY`). From Connect > Session pooler: the connection string on port 5432 (`DATABASE_URL`). Use the session pooler, not the transaction pooler on 6543: the worker's job queue needs a real session.

Check: the plan shows Pro and the project shows no pause warning.

## 3. Pick the domain

Buy it anywhere. Cloudflare Registrar is the simplest, since R2 is already on Cloudflare, but any registrar works; the DNS records come in step 8.

## 4. Cloudflare R2

The bucket exists. Two things are new.

**A token for the app and worker.** R2 > Manage API tokens > Create API token:
- Permissions: Object Read & Write.
- Specify bucket: your bucket only.
- It shows an Access Key ID and a Secret Access Key once. They go in `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, in both the app (Vercel) and the worker (Fly). The account ID on the R2 overview page is `R2_ACCOUNT_ID`; the bucket name is `R2_BUCKET`.

**Bucket rules.** Browsers now send files straight to R2, so the bucket must allow PUT from the app's address, and abandoned multipart uploads should clear after a day. Either:
- Run `node apps/web/scripts/r2-bucket.mjs https://app.<domain>` to print the rules, and paste the CORS part into the bucket > Settings > CORS policy, and add a lifecycle rule there that aborts incomplete multipart uploads after 1 day; or
- Make a second, temporary token with Admin Read & Write and run
  ```
  R2_ACCOUNT_ID=... R2_ADMIN_ACCESS_KEY_ID=... R2_ADMIN_SECRET_ACCESS_KEY=... R2_BUCKET=... \
    node apps/web/scripts/r2-bucket.mjs --apply https://app.<domain> http://localhost:3000
  ```
  then delete that admin token. `--apply` replaces the bucket's existing CORS and lifecycle rules and prints what was there first.

Keep `http://localhost:3000` in the list if you develop against R2.

Check: from `workers/`, with the R2 values in `workers/.env`, run `uv run python scripts/check_r2.py --origin https://app.<domain>`. Every line should pass, including "browser PUT" and "abandoned upload cleanup".

## 5. Modal: the search model

1. Make an account at modal.com. The Starter plan includes $30 of compute a month ([pricing](https://modal.com/pricing)).
2. On your laptop: `uvx modal setup`. It opens the browser and saves a token in `~/.modal.toml`. That token stays on your laptop; no service needs it.
3. Store the embed key as a Modal secret:
   ```
   uvx modal secret create binary-embed EMBED_API_KEY=<the embed key>
   ```
4. Deploy, from `workers/`:
   ```
   uvx modal deploy modal_embed.py
   ```
   The first deploy builds the image and downloads the model into it, which takes several minutes. It prints the URL, `https://<workspace>--binary-embed.modal.run`.

`EMBED_URL` is that URL plus `/embed`. It goes in the app (Vercel) and the worker (Fly), with `EMBED_API_KEY` set to the embed key.

Check, and measure (this is the cold-start plan):
1. `curl https://<workspace>--binary-embed.modal.run/healthz` answers `{"status":"ok","model":"Qwen/Qwen3-Embedding-0.6B"}`. The first call wakes the GPU, so it can take tens of seconds.
2. Leave it alone for 10 minutes so it scales to zero (the Modal dashboard shows 0 containers), then from `workers/`:
   ```
   EMBED_URL=https://<workspace>--binary-embed.modal.run/embed EMBED_API_KEY=<the embed key> \
     uv run python scripts/measure_embed.py --cold
   ```
   It prints the cold first query, warm p50 and p95 over 50 queries, how many went past the search page's 250 ms budget, and chunks per second for file chunks.
3. Run it three times at different hours and write the numbers into decisions.md under "going online". What they decide:
   - Warm p95 over 250 ms from your laptop is mostly the network; what counts is from Vercel's `iad1` region. If the app's search still says "Showing exact word matches only right now" while the service is warm, look at the function logs for the embed call's time.
   - The cold start is what the first search after a quiet spell costs: that search runs on exact words, and the next one is semantic. If it's over about 20 s, turn on Modal's memory snapshots for the class, which restore a loaded model instead of loading it.
   - A container stays up 5 minutes after the last request (`scaledown_window=300` in `modal_embed.py`). That window is most of the monthly cost; shorten it if the bill is high, lengthen it if people often hit a cold start.

## 6. Fly.io: the worker

1. Make an account at fly.io and add a card. There's no free tier for machines ([pricing](https://docs.fly.io/about/pricing)).
2. `brew install flyctl`, then `fly auth login`. No service needs a Fly token for this.
3. Create the app. The name in `workers/fly.toml` is `binary-worker`; names are global, so if it's taken, change `app =` in that file.
   ```
   fly apps create binary-worker
   ```
4. Secrets: copy `workers/.env.production.example` to `workers/.env.production` (git ignores it), fill in every value, then from the repo root:
   ```
   grep -E '^[A-Z]' workers/.env.production | fly secrets import --stage --config workers/fly.toml
   rm workers/.env.production
   ```
   `BINARY_ENV`, `EMBEDDER`, `PREVIEW_STORE` and `TRANSCRIBER` are already in `fly.toml`.
5. Deploy, from the repo root:
   ```
   fly deploy . --config workers/fly.toml --dockerfile workers/Dockerfile
   fly scale count 1 --config workers/fly.toml
   ```
   Fly builds the image on its own builders. Before starting the new version, it runs `bl migrate` against the database; a rerun applies nothing. There must be exactly one machine: the worker's 10-second schedulers expect one process.

Check:
- `fly status --config workers/fly.toml` shows one machine, started.
- `fly logs --config workers/fly.toml` shows "Starting worker on all queues" and no "The worker's environment isn't ready" list. If that list appears, it names every missing or wrong variable; fix them with `fly secrets set NAME=value --config workers/fly.toml` and it restarts by itself.
- `fly ssh console --config workers/fly.toml -C "ffmpeg -version"` prints a version.

**A lab's first scan.** Day to day the worker waits on Dropbox, R2 and Modal, and a shared CPU is enough. A first scan of thousands of files is CPU work for hours (reading PDFs, drawing previews), and Fly throttles a shared CPU to 1/16 of a core once its burst allowance runs out ([CPU performance](https://fly.io/docs/machines/cpu-performance)). Before connecting a big Dropbox:
```
fly scale vm performance-2x --vm-memory 4096 --config workers/fly.toml
```
and when the lab's progress bar is done:
```
fly scale vm shared-cpu-2x --vm-memory 4096 --config workers/fly.toml
```
A day on performance-2x costs about $2.20.

## 7. Vercel: the landing page and the app

1. Make an account at vercel.com and choose Pro. Hobby is for non-commercial use only ([pricing](https://vercel.com/pricing)).
2. Add New > Project > import this repo. Root Directory: `apps/landing`. Vercel detects Next.js; `apps/landing/vercel.json` sets the install and build commands. Under Build and Deployment, set Node.js Version to 22.x.
   - Environment variable (Production): `NEXT_PUBLIC_APP_URL=https://app.<domain>`.
3. Add New > Project > import the same repo again. Root Directory: `apps/web`. Node.js 22.x. `apps/web/vercel.json` sets the install and build commands and runs functions in `iad1`, next to the database.
   - Environment variables: every line of `apps/web/.env.production.example`, scoped to **Production only**. Preview deployments then show the "not configured" screen instead of writing to the live database.
4. Deploy both.

The install command is `npx --yes pnpm@12.16.1 install --frozen-lockfile`, because the app's lockfile was written by pnpm 12, which Vercel doesn't pick on its own.

If a production variable is missing or malformed, the app's build stops and the log lists all of them at once, e.g. "Binary's environment isn't ready for production: - EMBED_URL: missing". The same check runs when each server starts.

Check: both deployments are Ready; the landing page opens at its `.vercel.app` address and the app's address shows the sign-in page.

## 8. DNS

In Vercel, add the domains: `<domain>` and `www.<domain>` on the landing project, `app.<domain>` on the app project. Vercel then shows the exact records to add at your DNS host. They're usually:

| Type | Name | Value |
|---|---|---|
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |
| CNAME | `app` | `cname.vercel-dns.com` |

Use what Vercel shows if it differs. On Cloudflare DNS, set these records to "DNS only" (grey cloud), so Vercel can issue the certificates.

Resend's records come in step 10.

Check: `https://<domain>` and `https://app.<domain>` open with a valid certificate (a few minutes to an hour after the records).

## 9. Supabase sign-in addresses and Dropbox

**Supabase** > Authentication > URL Configuration:
- Site URL: `https://app.<domain>`
- Redirect URLs: add `https://app.<domain>/auth/callback`, `https://app.<domain>/auth/confirm` and `https://app.<domain>/` (invites land on the home page). Keep `http://localhost:3000/**` for development.

Supabase > Authentication > Email Templates > Invite user: point the link at
`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`
so an invited person lands signed in (decisions.md, "Supabase project and email"). Template edits need custom SMTP, so do this after step 10.

**Dropbox** > App Console > your app > Settings > OAuth 2 > Redirect URIs: add `https://app.<domain>/api/dropbox/callback`, exactly as in the app's `DROPBOX_REDIRECT_URI`. Keep the localhost one for development. An app in Development status can be linked by up to 500 Dropbox users, which covers the pilot.

Check: sign in at `https://app.<domain>` with a magic link (it arrives from Supabase's default sender until step 10), then Settings > Dropbox > Connect returns to the app connected.

## 10. Resend: email

1. Make an account at resend.com. The free plan sends 3,000 emails a month and 100 a day, plenty for sign-in links in a pilot ([pricing](https://resend.com/pricing)).
2. Domains > Add domain: `<domain>` (or a subdomain like `mail.<domain>`). Resend shows the records to add; they're usually an MX and a TXT (SPF) record on `send`, and a TXT (DKIM) record on `resend._domainkey`. Add them at your DNS host, then press Verify. A DMARC record (`TXT _dmarc "v=DMARC1; p=none;"`) helps delivery and is worth adding too.
3. API Keys > Create API key, permission "Sending access", limited to that domain.
4. Supabase > Authentication > Emails > SMTP Settings > enable custom SMTP:
   - Host `smtp.resend.com`, port `465`, username `resend`, password: the API key.
   - Sender email: e.g. `sign-in@<domain>`; sender name `Binary`.
5. Supabase > Authentication > Rate Limits: raise the email limit from its default to what a lab needs (100 an hour is plenty).
6. Now edit the invite template (step 9).

The Resend key lives only in Supabase; no Binary service reads it.

Check: Resend shows the domain Verified; a magic link arrives from your sender address, not Supabase's; an invite from Settings > Members lands the new person signed in.

## 11. End to end

On a phone and a laptop, signed in to `https://app.<domain>`:
- Upload: add a photo from the phone's camera and a PDF over 5 MB from the laptop. Both show "Reading", then a label within a minute. (Over 4.5 MB is the case that would have failed on Vercel before uploads went straight to R2.)
- Search: a query finds them, and the page doesn't say "Showing exact word matches only right now" (try twice if the GPU was asleep).
- A talk-through: record 30 seconds on a protocol page; a draft appears.
- A video on a protocol page plays and gets a poster.
- `fly logs` shows the jobs, with no errors.

## Variables, per service

| Variable | App (Vercel) | Worker (Fly) | Modal | Landing |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | | | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | | | |
| `DATABASE_URL` (session pooler, port 5432) | | yes | | |
| `TOKEN_ENCRYPTION_KEY` (same value in both) | yes | yes | | |
| `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` | yes | yes | | |
| `DROPBOX_REDIRECT_URI` | yes | | | |
| `PREVIEW_STORE=r2` | yes | fly.toml | | |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | yes | yes | | |
| `EMBED_URL` | yes | yes | | |
| `EMBED_API_KEY` (the embed key) | yes | yes | secret `binary-embed` | |
| `ANTHROPIC_API_KEY` | yes | yes | | |
| `ELEVENLABS_API_KEY` | | yes | | |
| `BINARY_ENV=production`, `EMBEDDER=remote`, `TRANSCRIBER=elevenlabs` | | fly.toml | | |
| `NEXT_PUBLIC_APP_URL` | | | | yes |

The templates are `apps/web/.env.production.example`, `workers/.env.production.example` and `apps/landing/.env.production.example`; tests fail if they drift from what the code reads.

## What it costs a month

Prices checked on 2026-11-05.

| Service | Plan | Monthly | Source |
|---|---|---|---|
| Vercel | Pro, one developer seat (both projects) | $20, with $20 of usage included | [vercel.com/pricing](https://vercel.com/pricing) |
| Supabase | Pro, Micro compute | $25 | [supabase.com/pricing](https://supabase.com/pricing) |
| Fly.io | shared-cpu-2x, 4 GB, always on, `iad` | about $25 ($13.39 for 2 GB plus $6 per extra GB) | [docs.fly.io/about/pricing](https://docs.fly.io/about/pricing) |
| Modal | Starter, L4 at $0.000222/s (about $0.80/h) | $0 to $15 after the $30 credit (below) | [modal.com/pricing](https://modal.com/pricing) |
| Cloudflare R2 | $0.015 per GB-month past 10 GB, no egress fees | under $1 for a pilot lab's 20 to 50 GB | [developers.cloudflare.com/r2/pricing](https://developers.cloudflare.com/r2/pricing/) |
| Resend | Free (3,000 emails/month) | $0; Pro is $20 for 50,000 | [resend.com/pricing](https://resend.com/pricing) |
| Domain | | about $1 (about $10 to $15 a year) | |
| **Total** | | **about $70 to $85**, plus Anthropic and ElevenLabs usage as today | |

Modal bills a container only while it's up. Each search session keeps it up for its length plus the 5-minute idle window, so about 7 minutes for a short session: 5 sessions a workday is about 13 hours a month ($11), 20 a day is about 51 hours ($41). The Starter credit covers the first $30. A lab's first scan adds well under $1 of GPU time (decisions.md). A first scan on performance-2x for a day adds about $2.

## What this leaves unproven

Built and tested here, but never run against the real thing:
- **Presigned PUTs to R2 from a browser.** The URL's signature (size and type pinned, staging key under the lab) is unit-tested offline, and the whole flow runs against the local store. A real bucket, its CORS rule and a phone's browser are the first real test; `scripts/check_r2.py` after step 4 covers the bucket side.
- **Modal**: the image build, the GPU, the cold start and the real throughput. The throughput in decisions.md is an estimate from a Mac's GPU. `scripts/measure_embed.py` gives the real numbers.
- **The worker image.** There's no Docker on the machine this was built on, so it has never been built. The size is an estimate from the installed dependencies.
- **Fly**: the release command, the restart policy, and that 4 GB holds in practice.
- **Vercel**: the install command with pnpm 12, the build with the production check on, and how long the upload complete calls take reading a file back from R2.
- **Resend and Supabase SMTP**, the invite template, and the auth redirects on the real domain.
