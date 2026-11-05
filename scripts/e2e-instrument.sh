#!/usr/bin/env bash
# The instrument uploader end to end on local Postgres and a local object store. Serves the
# uploader's real route handlers over HTTP (src/lib/__tests__/instrument-e2e.test.ts), pairs the
# real release binary with a fresh code, then drops a CSV, a file written over 10 s and a 20 MB
# file into the watched folder. The uploader is killed mid-send and restarted; the part log
# shows which parts went twice. Then the real worker indexes and labels the files and the
# labels show the instrument. Build the uploader first (cargo build --release). Cleans up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB=binary_labs_e2e_instrument
export DATABASE_URL="postgresql://localhost/$DB"
export PREVIEW_STORE=local
export PREVIEW_DIR=.data/e2e-instrument-store
export EMBED_MODEL=hash-1024
export TOKEN_ENCRYPTION_KEY="${TOKEN_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
unset ANTHROPIC_API_KEY
PORT="${E2E_PORT:-3101}"
BIN="$ROOT/instruments/uploader/target/release/binary-labs-uploader"
DIR="$ROOT/workers/.data/e2e-instrument"
PC="$DIR/pc/Exports"
CONF="$DIR/uploader"
USER_ID=00000000-0000-0000-0000-0000000000e7
PIDS=()
KEEP="${E2E_KEEP:-}"; [[ "${1:-}" == "--keep" ]] && KEEP=1
cleanup() {
  touch "$DIR/stop" 2>/dev/null || true
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  if [[ -z "$KEEP" ]]; then
    sleep 1
    dropdb --if-exists --force "$DB" 2>/dev/null || true
    rm -rf "$ROOT/workers/$PREVIEW_DIR" "$DIR"
  fi
}
trap cleanup EXIT

as_member() {
  psql -qtAX -v ON_ERROR_STOP=1 -d "$DB" \
    -c "set role authenticated" -c "set request.jwt.claim.sub = '$USER_ID'" -c "$1"
}
parts_of() { grep -c "^$1 " "$DIR/parts.log" || true; }

[[ -x "$BIN" ]] || { echo "build the uploader first: cargo build --release in instruments/uploader"; exit 1; }
dropdb --if-exists --force "$DB" && createdb "$DB"
rm -rf "$ROOT/workers/$PREVIEW_DIR" "$DIR" && mkdir -p "$PC/P450" "$CONF"
cd "$ROOT/workers"
uv run bl migrate --test-stub > /dev/null

psql -qtAX -d "$DB" -c "insert into auth.users (id, email) values ('$USER_ID', 'manager@lab.test')"
LAB_ID="$(as_member "select create_lab('Instrument E2E lab')" | tail -1)"
as_member "insert into experiments (lab_id, name) values ('$LAB_ID', 'P450')"

cd "$ROOT/apps/web"
E2E_DATABASE_URL="$DATABASE_URL" E2E_USER="$USER_ID" E2E_LAB="$LAB_ID" E2E_PORT="$PORT" \
  E2E_CODE_FILE="$DIR/code" E2E_PART_LOG="$DIR/parts.log" E2E_STOP_FILE="$DIR/stop" E2E_PART_DELAY_MS=1500 \
  PREVIEW_DIR="$PREVIEW_DIR" pnpm exec vitest run --project unit src/lib/__tests__/instrument-e2e.test.ts \
  > "$DIR/server.log" 2>&1 & PIDS+=($!)
for _ in $(seq 120); do [[ -s "$DIR/code" ]] && break; sleep 0.5; done
CODE="$(cat "$DIR/code")"
echo "== an admin added 'Plate reader, room 214' and got a code"

echo "== pair with a wrong code, then the real one"
"$BIN" --config-dir "$CONF" pair "http://127.0.0.1:$PORT" ZZZZ-ZZZZ && exit 1 || true
"$BIN" --config-dir "$CONF" pair "http://127.0.0.1:$PORT" "$CODE"
"$BIN" --config-dir "$CONF" pair "http://127.0.0.1:$PORT" "$CODE" 2>/dev/null && { echo "a used code paired"; exit 1; } || echo "the code doesn't pair twice"
stat -f "config mode %Lp" "$CONF/config.json"
"$BIN" --config-dir "$CONF" add-folder "$PC"

"$BIN" --config-dir "$CONF" run > "$DIR/run1.log" 2>&1 & RUN=$!; PIDS+=($RUN)

printf 'Well,Fluorescence\nA1,1200\nA2,1350\nB1,980\n' > "$PC/P450/plate07_read1.csv"
printf 'lock' > "$PC/P450/~\$plate07_read1.csv"
printf 'tmp' > "$PC/P450/export.tmp"
head -c $((20 * 1024 * 1024)) /dev/urandom > "$DIR/big.bin"
cp "$DIR/big.bin" "$PC/P450/stack_20MB.bin"
(
  for i in $(seq 1 10); do printf 'cycle,%s,temp,%s\n' "$i" "$((60 + i))" >> "$PC/P450/melt_curve.csv"; sleep 1; done
) &
GROW=$!
GROW_STARTED=$(date +%s)

BIG_SHA="$(shasum -a 256 "$DIR/big.bin" | cut -d' ' -f1)"
echo "== waiting for the 20 MB file's first part, then killing the uploader"
big_session() {
  python3 -c "import json; s=json.load(open('$CONF/state.json'))
for i in s['queue'].values():
    u = i['phase'].get('work', {}).get('upload') if isinstance(i['phase'], dict) else None
    if u and i['path'].endswith('stack_20MB.bin'): print(u['session']['uploadId'], len(u['session']['etags']))" 2>/dev/null || true
}
for _ in $(seq 240); do
  read -r UPLOAD_ID done_parts <<< "$(big_session) "
  [[ "${done_parts:-0}" -ge 1 ]] && break
  sleep 0.5
done
kill -9 "$RUN"
echo "killed with $done_parts of 3 parts confirmed; parts sent so far: $(parts_of "$UPLOAD_ID")"
"$BIN" --config-dir "$CONF" status | sed -n '1,30p'

"$BIN" --config-dir "$CONF" run > "$DIR/run2.log" 2>&1 & PIDS+=($!)
wait "$GROW"
for _ in $(seq 120); do
  n="$(psql -qtAX -d "$DB" -c "select count(*) from file_locations fl join sources s on s.id = fl.source_id where s.kind = 'instrument'")"
  [[ "$n" -ge 3 ]] && break
  sleep 1
done
echo "== part log for the 20 MB upload (upload, part, status)"
grep "^$UPLOAD_ID " "$DIR/parts.log"
echo "each part sent once: $(cut -d' ' -f2 <<< "$(grep "^$UPLOAD_ID " "$DIR/parts.log")" | sort | uniq -d | wc -l | tr -d ' ') parts repeated"
grow_sent="$(psql -qtAX -d "$DB" -c "select extract(epoch from seen_at)::int from file_locations where path like '%melt_curve.csv'")"
echo "melt_curve.csv recorded $((grow_sent - GROW_STARTED)) s after writing began (writing took 10 s)"
lines="$(psql -qtAX -d "$DB" -c "select size from file_locations where path like '%melt_curve.csv'")"
echo "melt_curve.csv recorded at $lines bytes; on disk $(stat -f %z "$PC/P450/melt_curve.csv")"

cd "$ROOT/workers"
uv run bl worker > "$DIR/worker.log" 2>&1 & PIDS+=($!)
start=$(date +%s)
while :; do
  left="$(psql -qtAX -d "$DB" -c "select count(*) from file_locations fl join sources s on s.id = fl.source_id
    where s.kind = 'instrument' and (fl.index_state = 'pending' or not exists (select 1 from labels l where l.lab_id = fl.lab_id and l.sha256 = fl.sha256))")"
  [[ "$left" == 0 ]] && break
  (( $(date +%s) - start > 300 )) && { echo "not indexed in 5 min"; tail -20 "$DIR/worker.log"; exit 1; }
  sleep 2
done
echo "indexed and labeled $(( $(date +%s) - start ))s after the worker started"

echo "== the files, as the lab sees them"
as_member "select fl.path, fl.index_state, l.instrument, l.status, l.clean_name
  from file_locations fl left join labels l on l.lab_id = fl.lab_id and l.sha256 = fl.sha256
  join sources s on s.id = fl.source_id where s.kind = 'instrument' order by fl.path"
echo "== stored 20 MB file matches: $( [[ "$(psql -qtAX -d "$DB" -c "select sha256 from file_locations where path like '%stack_20MB.bin'")" == "$BIG_SHA" ]] && echo yes || echo no)"
echo "== Settings"
as_member "select name, state, files, seen_seconds_ago from lab_instruments('$LAB_ID')"
echo "== uploader status"
"$ROOT/instruments/uploader/target/release/binary-labs-uploader" --config-dir "$CONF" status | sed -n '1,20p'
echo "== temp and lock files recorded: $(psql -qtAX -d "$DB" -c "select count(*) from file_locations where original_name like '~\$%' or original_name like '%.tmp'")"
