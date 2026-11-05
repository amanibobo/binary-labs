#!/usr/bin/env bash
# Speaks a short procedure with macOS `say`, lays it over an ffmpeg test pattern as a phone-like
# MP4, sends it to a protocol page through the video upload routes' core (in parts, checked and
# recorded on the server) on local Postgres and a local object store, then runs the real worker
# until the video is linked, has a poster and is transcribed. Shows the transcript, what it
# cost and a search for something said. Transcription is real (ElevenLabs) when
# E2E_ELEVENLABS_API_KEY is set, or E2E_KEYS_FROM names an env file to take it from;
# workers/.env is never read here. Embeddings use the hash embedder. Cleans up after itself.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB=binary_labs_e2e_video
export DATABASE_URL="postgresql://localhost/$DB"
export PREVIEW_STORE=local
export PREVIEW_DIR=.data/e2e-video-store
export EMBED_MODEL=hash-1024
export TRANSCRIBER=elevenlabs
export TOKEN_ENCRYPTION_KEY="${TOKEN_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
key_from() { [[ -n "${E2E_KEYS_FROM:-}" ]] && sed -n "s/^$1=//p" "$E2E_KEYS_FROM" | tail -1 || true; }
export ELEVENLABS_API_KEY="${E2E_ELEVENLABS_API_KEY:-$(key_from ELEVENLABS_API_KEY)}"
[[ -n "$ELEVENLABS_API_KEY" ]] && echo "transcriber: ElevenLabs" || echo "transcriber: none set, the transcript will fail"
DIR="$ROOT/workers/.data/e2e-video"
CLIP="$DIR/Loading the nickel column.mp4"
USER_ID=00000000-0000-0000-0000-0000000000e5
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  if [[ -z "${E2E_KEEP:-}" ]]; then
    dropdb --if-exists --force "$DB" 2>/dev/null || true
    rm -rf "$ROOT/workers/$PREVIEW_DIR" "$DIR"
  fi
}
trap cleanup EXIT

as_member() {
  psql -qtAX -v ON_ERROR_STOP=1 -d "$DB" \
    -c "set role authenticated" -c "set request.jwt.claim.sub = '$USER_ID'" -c "$1"
}

dropdb --if-exists --force "$DB" && createdb "$DB"
cd "$ROOT/workers"
rm -rf "$PREVIEW_DIR" "$DIR" && mkdir -p "$DIR"
uv run bl migrate --test-stub

say -o "$DIR/voice.aiff" "This is how we load the lysate onto the nickel column. Equilibrate the column \
with five column volumes of lysis buffer at one milliliter a minute. Load the cleared lysate slowly, \
and never let the column run dry. Keep the flow through on ice for the gel."
ffmpeg -hide_banner -v error -y -f lavfi -i testsrc2=size=1280x720:rate=30 -i "$DIR/voice.aiff" \
  -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k -shortest -movflags +faststart "$CLIP"
rm "$DIR/voice.aiff"
ls -l "$CLIP" | awk '{print "clip bytes " $5}'

psql -qtAX -d "$DB" -c "insert into auth.users (id, email, raw_user_meta_data) values ('$USER_ID', 'ana@lab.test', '{\"full_name\": \"Ana Ruiz\"}')"
LAB_ID="$(as_member "select create_lab('Video E2E lab')" | tail -1)"
PAGE_ID="$(as_member "select protocol_id from create_protocol('$LAB_ID', 'tutorial', 'Loading the nickel column', '1. Equilibrate.')" | tail -1)"
echo "lab $LAB_ID page $PAGE_ID"

cd "$ROOT/apps/web"
E2E_DATABASE_URL="$DATABASE_URL" E2E_USER="$USER_ID" E2E_LAB="$LAB_ID" E2E_PROTOCOL="$PAGE_ID" E2E_VIDEO="$CLIP" \
  PREVIEW_DIR="$PREVIEW_DIR" pnpm exec vitest run --project unit src/lib/__tests__/video-e2e.test.ts

cd "$ROOT/workers"
uv run bl worker > "$ROOT/workers/.data/e2e-video-worker.log" 2>&1 & PIDS+=($!)
start=$(date +%s)
while :; do
  row="$(as_member "select state || ' ' || coalesce(transcript::text, '-') || ' ' || has_poster from protocol_videos('$PAGE_ID')" | tail -1)"
  echo "video $row"
  [[ "$row" == ready\ ready* || "$row" == ready\ failed* || "$row" == ready\ unavailable* || "$row" == failed* ]] && break
  (( $(date +%s) - start > 600 )) && { echo "the video did not settle in 10 min"; exit 1; }
  sleep 3
done
echo "settled $(( $(date +%s) - start ))s after the worker started"

echo "== transcript"
as_member "select coalesce(transcript_text, transcript_error, error) from protocol_videos('$PAGE_ID')"
echo "== linked as"
psql -qtAX -d "$DB" -c "select action, actor = '$USER_ID' from audit_log where lab_id = '$LAB_ID' and action = 'protocol.link_file'"
echo "== ledger"
psql -qtAX -d "$DB" -c "select purpose, model, cost_usd, output ->> 'duration_s' from model_calls where lab_id = '$LAB_ID' and purpose = 'transcript'"
echo "== search for what was said"
as_member "select locations -> 0 ->> 'path' from search_files('$LAB_ID', 'never let the column run dry') limit 3"
