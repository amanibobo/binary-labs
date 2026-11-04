#!/usr/bin/env bash
# Scans a generated sample lab end to end on local Postgres and checks search as a lab member.
# Covers worker + SQL + /embed. The web app needs Supabase (auth + PostgREST), so it is checked separately.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB=binary_labs_e2e
export DATABASE_URL="postgresql://localhost/$DB"
export PREVIEW_STORE=local
export EMBED_API_KEY="${EMBED_API_KEY:-e2e-key}"
export TOKEN_ENCRYPTION_KEY="${TOKEN_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
SAMPLE="$ROOT/workers/.data/sample-lab"
USER_ID=00000000-0000-0000-0000-0000000000e2
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

as_member() {
  psql -qtAX -v ON_ERROR_STOP=1 -d "$DB" \
    -c "set role authenticated" -c "set request.jwt.claim.sub = '$USER_ID'" -c "$1"
}

dropdb --if-exists "$DB" && createdb "$DB"
cd "$ROOT/workers"
uv run bl migrate --test-stub
rm -rf "$SAMPLE" && uv run python scripts/make_sample_lab.py "$SAMPLE"

psql -qtAX -d "$DB" -c "insert into auth.users (id, email) values ('$USER_ID', 'e2e@lab.test')"
LAB_ID="$(as_member "select create_lab('E2E lab')" | tail -1)"
echo "lab $LAB_ID"

uv run bl serve-embed > "$ROOT/workers/.data/embed.log" 2>&1 & PIDS+=($!)
uv run bl worker > "$ROOT/workers/.data/worker.log" 2>&1 & PIDS+=($!)
uv run bl scan-local "$LAB_ID" "$SAMPLE"

start=$(date +%s)
until curl -sf localhost:8787/healthz > /dev/null; do
  (( $(date +%s) - start > 300 )) && { echo "embed server never came up"; exit 1; }
  sleep 2
done

start=$(date +%s)
while :; do
  read -r pending indexed failed <<< "$(as_member "select coalesce(sum(pending),0), coalesce(sum(indexed),0), coalesce(sum(failed),0) from source_progress('$LAB_ID')" | tail -1 | tr '|' ' ')"
  echo "pending $pending  indexed $indexed  failed $failed"
  (( indexed > 0 && pending == 0 )) && break
  (( $(date +%s) - start > 900 )) && { echo "scan did not finish in 15 min"; exit 1; }
  sleep 5
done
echo "scan took $(( $(date +%s) - start ))s after the embed server was up"
(( failed == 0 )) || as_member "select path, index_error from file_locations where index_state = 'failed'"

embed_query() {
  curl -sf -X POST localhost:8787/embed -H "Authorization: Bearer $EMBED_API_KEY" \
    -H 'content-type: application/json' -d "{\"text\": \"$1\"}" \
    | python3 -c 'import json,sys; print("[" + ",".join(map(str, json.load(sys.stdin)["embedding"])) + "]")'
}

for q in "P450 gels from batch 3" "final" "plate reader absorbance" "buffer recipe"; do
  vec="$(embed_query "$q")"
  echo "== $q"
  as_member "select keyword_rank, vector_rank, locations->0->>'path', jsonb_array_length(locations) from search_files('$LAB_ID', '$q', '$vec'::vector) limit 5"
done

echo "== dedupe: blobs with more than one live location"
as_member "select sha256, count(*) from file_locations where lab_id = '$LAB_ID' and deleted_at is null group by sha256 having count(*) > 1"

echo "== /embed latency, 50 short queries after warmup"
for _ in 1 2 3; do embed_query "warmup" > /dev/null; done
for i in $(seq 1 50); do
  curl -s -o /dev/null -w '%{time_total}\n' -X POST localhost:8787/embed \
    -H "Authorization: Bearer $EMBED_API_KEY" -H 'content-type: application/json' \
    -d "{\"text\": \"query number $i about gels\"}"
done | sort -n | awk '{a[NR]=$1} END {printf "p50 %.0f ms  p90 %.0f ms\n", a[int(NR*0.5)]*1000, a[int(NR*0.9)]*1000}'

echo "== keyword-only search timing, 20 runs"
for _ in $(seq 1 20); do
  /usr/bin/time -p psql -qtAX -d "$DB" -c "set role authenticated" -c "set request.jwt.claim.sub = '$USER_ID'" \
    -c "select count(*) from search_files('$LAB_ID', 'P450 gel batch')" 2>&1 >/dev/null | awk '/real/ {print $2}'
done | sort -n | awk '{a[NR]=$1} END {printf "p50 %.0f ms (includes psql startup)\n", a[int(NR*0.5)]*1000}'

echo "== rescan is a no-op"
before="$(as_member "select count(*), max(indexed_at) from file_locations where lab_id = '$LAB_ID'")"
uv run bl scan-local "$LAB_ID" "$SAMPLE"
sleep 25
after="$(as_member "select count(*), max(indexed_at) from file_locations where lab_id = '$LAB_ID'")"
[[ "$before" == "$after" ]] && echo "unchanged: $after" || { echo "rescan changed rows: $before -> $after"; exit 1; }
