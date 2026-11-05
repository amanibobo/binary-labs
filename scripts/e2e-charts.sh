#!/usr/bin/env bash
# Puts the three instrument exports from workers/tests/fixtures/tables in a local folder, scans
# it with the real worker on local Postgres and a local store, and waits for each file's full
# table. Then a file indexed "before charts" (its table row removed) is asked for as a member,
# the way the chart builder asks, and the worker parses it again. Last, the routes' core reads
# each table from the store, saves a chart of it as the member and exports it as SVG. Embeddings
# use the hash embedder and labels the rules only. Cleans up after itself unless E2E_KEEP is set.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB=binary_labs_e2e_charts
export DATABASE_URL="postgresql://localhost/$DB"
export PREVIEW_STORE=local
export PREVIEW_DIR=.data/e2e-charts-store
export EMBED_MODEL=hash-1024
export TOKEN_ENCRYPTION_KEY="${TOKEN_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
DIR="$ROOT/workers/.data/e2e-charts"
OUT="$DIR/out"
USER_ID=00000000-0000-4000-8000-0000000000e7
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

ready_tables() {
  psql -qtAX -d "$DB" -c "select count(*) filter (where state = 'ready'), count(*) from data_tables where lab_id = '$LAB_ID'"
}

wait_for_tables() {
  local start
  start=$(date +%s)
  while :; do
    row="$(ready_tables)"
    echo "tables ready|all: $row"
    [[ "$row" == "$1|$1" ]] && break
    (( $(date +%s) - start > 180 )) && { echo "tables did not settle in 3 min"; exit 1; }
    sleep 2
  done
  echo "settled $(( $(date +%s) - start ))s"
}

dropdb --if-exists --force "$DB" && createdb "$DB"
cd "$ROOT/workers"
rm -rf "$PREVIEW_DIR" "$DIR" && mkdir -p "$DIR/lab/Instruments" "$OUT"
cp tests/fixtures/tables/* "$DIR/lab/Instruments/"
uv run bl migrate --test-stub

psql -qtAX -d "$DB" -c "insert into auth.users (id, email) values ('$USER_ID', 'e2e-charts@lab.test')"
LAB_ID="$(as_member "select create_lab('Charts E2E lab')" | tail -1)"
echo "lab $LAB_ID"

uv run bl worker > "$DIR/worker.log" 2>&1 & PIDS+=($!)
uv run bl scan-local "$LAB_ID" "$DIR/lab"
wait_for_tables 3
psql -qtAX -d "$DB" -c "select fl.original_name, t.state, t.parser_version, t.storage_key from data_tables t
  join file_locations fl on fl.sha256 = t.sha256 and fl.lab_id = t.lab_id where t.lab_id = '$LAB_ID' order by 1"

echo "== a file indexed before charts: its table is asked for, then parsed"
SHA="$(psql -qtAX -d "$DB" -c "select sha256 from file_locations where lab_id = '$LAB_ID' and original_name = 'plate7_A420.csv'")"
psql -qtAX -d "$DB" -c "delete from data_tables where lab_id = '$LAB_ID' and sha256 = '$SHA'"
as_member "select request_data_table('$LAB_ID', '$SHA')"
wait_for_tables 3

echo "== the routes' core: read each table, save a chart as the member, export SVG"
cd "$ROOT/apps/web"
E2E_DATABASE_URL="$DATABASE_URL" E2E_USER="$USER_ID" E2E_LAB="$LAB_ID" E2E_OUT="$OUT" PREVIEW_DIR="$PREVIEW_DIR" \
  pnpm exec vitest run --project unit src/lib/__tests__/chart-e2e.test.ts
echo "== charts saved, and their audit rows"
psql -qtAX -d "$DB" -c "select title, spec ->> 'type', jsonb_array_length(spec -> 'series') from charts where lab_id = '$LAB_ID' order by title"
psql -qtAX -d "$DB" -c "select action, count(*) from audit_log where lab_id = '$LAB_ID' and action::text like 'chart.%' group by 1"
ls -l "$OUT"
if [[ -n "${E2E_SVG_COPY:-}" ]]; then cp "$OUT"/*.svg "$E2E_SVG_COPY"/; fi
