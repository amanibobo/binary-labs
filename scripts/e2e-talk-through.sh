#!/usr/bin/env bash
# Speaks a short procedure with macOS `say`, sends it as a talk-through through the upload
# route's core on local Postgres and a local object store, runs the real worker until the
# steps are drafted, then shows the transcript, the draft and what it cost. Transcription is
# real (ElevenLabs) when E2E_ELEVENLABS_API_KEY is set, and drafting is real when
# E2E_ANTHROPIC_API_KEY is set; workers/.env is never read here. Embeddings use the hash
# embedder, so no model download is needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB=binary_labs_e2e_talk
export DATABASE_URL="postgresql://localhost/$DB"
export PREVIEW_STORE=local
export PREVIEW_DIR=.data/e2e-talk-store
export EMBED_MODEL=hash-1024
export TRANSCRIBER=elevenlabs
export TOKEN_ENCRYPTION_KEY="${TOKEN_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
# E2E_KEYS_FROM names an env file to take only these two keys from, without printing them.
key_from() { [[ -n "${E2E_KEYS_FROM:-}" ]] && sed -n "s/^$1=//p" "$E2E_KEYS_FROM" | tail -1 || true; }
export ELEVENLABS_API_KEY="${E2E_ELEVENLABS_API_KEY:-$(key_from ELEVENLABS_API_KEY)}"
export ANTHROPIC_API_KEY="${E2E_ANTHROPIC_API_KEY:-$(key_from ANTHROPIC_API_KEY)}"
[[ -n "$ELEVENLABS_API_KEY" ]] && echo "transcriber: ElevenLabs" || echo "transcriber: none set, the recording will fail"
[[ -n "$ANTHROPIC_API_KEY" ]] && echo "drafting: Claude" || echo "drafting: no model, the transcript is the fallback"
DIR="$ROOT/workers/.data/e2e-talk-through"
AUDIO="$DIR/mini prep talk-through.m4a"
USER_ID=00000000-0000-0000-0000-0000000000e4
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

as_member() {
  psql -qtAX -v ON_ERROR_STOP=1 -d "$DB" \
    -c "set role authenticated" -c "set request.jwt.claim.sub = '$USER_ID'" -c "$1"
}

dropdb --if-exists "$DB" && createdb "$DB"
cd "$ROOT/workers"
rm -rf "$PREVIEW_DIR" "$DIR" && mkdir -p "$DIR"
uv run bl migrate --test-stub

say -o "$DIR/clip.aiff" "Okay, this is how I run a mini prep. You'll need the overnight culture, buffer P1, \
buffer P2, buffer N3 and the spin columns. First spin down two milliliters of culture at eight thousand g \
for two minutes and pour off the supernatant. Resuspend the pellet in two hundred fifty microliters of P1. \
Add two hundred fifty microliters of P2 and invert the tube four to six times. Don't vortex it at this \
point, or you'll shear the genomic DNA. Then add three hundred fifty microliters of N3, invert again, and \
spin for ten minutes at top speed. Move the supernatant onto the column."
afconvert -f m4af -d aac "$DIR/clip.aiff" "$AUDIO"
rm "$DIR/clip.aiff"
afinfo "$AUDIO" | grep -i duration

psql -qtAX -d "$DB" -c "insert into auth.users (id, email, raw_user_meta_data) values ('$USER_ID', 'priya@lab.test', '{\"full_name\": \"Priya Nair\"}')"
LAB_ID="$(as_member "select create_lab('Talk-through E2E lab')" | tail -1)"
echo "lab $LAB_ID"

cd "$ROOT/apps/web"
E2E_DATABASE_URL="$DATABASE_URL" E2E_USER="$USER_ID" E2E_LAB="$LAB_ID" E2E_AUDIO="$AUDIO" \
  pnpm exec vitest run --project unit src/lib/__tests__/talk-through-e2e.test.ts
TT_ID="$(psql -qtAX -d "$DB" -c "select id from talk_throughs where lab_id = '$LAB_ID'")"

cd "$ROOT/workers"
uv run bl worker > "$ROOT/workers/.data/e2e-talk-through-worker.log" 2>&1 & PIDS+=($!)
start=$(date +%s)
while :; do
  read -r state draft <<< "$(as_member "select index_state, draft from talk_through('$TT_ID')" | tail -1 | tr '|' ' ')"
  echo "audio $state  draft $draft"
  [[ "$state" == failed || ( "$state" == indexed && "$draft" != waiting ) ]] && break
  (( $(date +%s) - start > 600 )) && { echo "the talk-through did not settle in 10 min"; exit 1; }
  sleep 3
done
echo "settled $(( $(date +%s) - start ))s after the worker started"

echo "== transcript"
as_member "select coalesce(index_error, transcript) from talk_through('$TT_ID')"
echo "== draft ($(as_member "select draft from talk_through('$TT_ID')" | tail -1))"
as_member "select coalesce(draft_title || E'\n\n' || draft_body, draft_error) from talk_through('$TT_ID')"
echo "== ledger"
psql -qtAX -d "$DB" -c "select purpose, model, input_tokens, output_tokens, cost_usd, output ->> 'duration_s' from model_calls where lab_id = '$LAB_ID' order by created_at"
psql -qtAX -d "$DB" -c "select 'total \$' || sum(cost_usd) from model_calls where lab_id = '$LAB_ID'"
echo "== search for what was said"
as_member "select locations -> 0 ->> 'path' from search_files('$LAB_ID', 'shear genomic DNA') limit 3"
