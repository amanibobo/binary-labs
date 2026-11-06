#!/usr/bin/env bash
# A protocol with checks, then data files arriving: the real worker on local Postgres and a
# local store indexes them, parses their tables, labels them from their folder (rules only) and
# checks them against the protocol of their experiment. Exactly two flags must come up: the
# Bradford curve whose fit misses R² ≥ 0.98, and the plate whose blanks read over 0.10. Then a
# member answers one, the routes' core reads them, and loosening the curve's range (a new
# protocol version) clears that flag. Cleans up after itself unless E2E_KEEP is set.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB="${E2E_DB:-binary_labs_e2e_checks}"
export DATABASE_URL="postgresql://localhost/$DB"
export PREVIEW_STORE=local
export PREVIEW_DIR=.data/e2e-checks-store
export EMBED_MODEL=hash-1024
export TOKEN_ENCRYPTION_KEY="${TOKEN_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
DIR="$ROOT/workers/.data/e2e-checks"
USER_ID=00000000-0000-4000-8000-0000000000c7
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  if [[ -z "${E2E_KEEP:-}" ]]; then
    dropdb --if-exists --force "$DB" 2>/dev/null || true
    rm -rf "$ROOT/workers/$PREVIEW_DIR" "$DIR"
  fi
}
trap cleanup EXIT

q() { psql -qtAX -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
as_member() {
  psql -qtAX -v ON_ERROR_STOP=1 -d "$DB" \
    -c "set role authenticated" -c "set request.jwt.claim.sub = '$USER_ID'" -c "$1"
}

# Every file indexed and labeled, every table ready, and no check waiting.
settled() {
  q "select
       (select count(*) from file_locations where lab_id = '$LAB_ID' and index_state = 'pending')
     + (select count(*) from file_locations fl where fl.lab_id = '$LAB_ID'
          and not exists (select 1 from labels l where l.lab_id = fl.lab_id and l.sha256 = fl.sha256))
     + (select count(*) from data_tables where lab_id = '$LAB_ID' and state = 'waiting')
     + (select count(*) from check_requests where lab_id = '$LAB_ID'
          and (checked_at is null or requested_at > checked_at))"
}

wait_settled() {
  local start
  start=$(date +%s)
  sleep 2
  while [[ "$(settled)" != "0" ]]; do
    (( $(date +%s) - start > 180 )) && { echo "did not settle in 3 min"; tail -40 "$DIR/worker.log"; exit 1; }
    sleep 2
  done
  echo "settled $(( $(date +%s) - start ))s"
}

open_flags() {
  q "select fl.original_name || ' ' || f.kind || ' ' || f.observed || ' v' || v.version
     from flags f join protocol_versions v on v.id = f.protocol_version_id
     join file_locations fl on fl.lab_id = f.lab_id and fl.sha256 = f.sha256
     where f.lab_id = '$LAB_ID' and f.cleared_at is null order by 1"
}

expect() {
  if [[ "$2" != "$3" ]]; then
    echo "FAIL: $1"; echo "  expected: $3"; echo "  got:      $2"; exit 1
  fi
  echo "ok: $1"
}

dropdb --if-exists --force "$DB" && createdb "$DB"
cd "$ROOT/workers"
rm -rf "$PREVIEW_DIR" "$DIR" && mkdir -p "$DIR/lab/Bradford" "$DIR/lab/Plates" "$DIR/lab/Notes"
F=tests/fixtures/tables
cp "$F/Bradford_2026-11-03.xlsx" "$F/Bradford_2026-11-04.xlsx" "$DIR/lab/Bradford/"
cp "$F/plate8_A595_endpoint.csv" "$F/plate9_A595_endpoint.csv" "$DIR/lab/Plates/"
cp "$F/spectrum_BM3_2026-11-03.csv" "$DIR/lab/Notes/"
uv run bl migrate --test-stub

q "insert into auth.users (id, email) values ('$USER_ID', 'e2e-checks@lab.test')"
LAB_ID="$(as_member "select create_lab('Checks E2E lab')" | tail -1)"
echo "lab $LAB_ID"

echo "== a protocol with two checks, tied to the experiments its files belong to"
CHECKS='[
  {"id": "0f8f2c1e-00c1-4a4e-8c55-0c3c1a7a00c1", "name": "Standard curve fit", "kind": "curve_fit",
   "sheet": null, "unit": null, "range": {"kind": "at_least", "min": 0.98}, "x": null, "y": null},
  {"id": "0f8f2c1e-00c2-4a4e-8c55-0c3c1a7a00c2", "name": "Blanks", "kind": "control",
   "sheet": null, "unit": "AU", "range": {"kind": "at_most", "max": 0.1}, "pattern": "blank",
   "labelColumn": null, "column": "A595", "use": "each"}
]'
PROTOCOL="$(as_member "select protocol_id from create_protocol('$LAB_ID', 'protocol', 'Bradford assay', 'Read at 595 nm.')" | tail -1)"
V1="$(q "select current_version_id from protocols where id = '$PROTOCOL'")"
as_member "select version from save_checks('$PROTOCOL', '$V1', '$CHECKS'::jsonb, 'First checks')" >/dev/null
as_member "insert into experiments (lab_id, name, protocol_id) values ('$LAB_ID', 'Bradford', '$PROTOCOL'), ('$LAB_ID', 'Plates', '$PROTOCOL'), ('$LAB_ID', 'Notes', null)"

echo "== data files arrive"
uv run bl worker > "$DIR/worker.log" 2>&1 & PIDS+=($!)
uv run bl scan-local "$LAB_ID" "$DIR/lab"
wait_settled

q "select fl.original_name, coalesce(e.name, '-'), r.outcome, coalesce(r.observed::text, r.reason)
   from check_results r join file_locations fl on fl.lab_id = r.lab_id and fl.sha256 = r.sha256
   left join labels l on l.lab_id = r.lab_id and l.sha256 = r.sha256
   left join experiments e on e.id = l.experiment_id
   where r.lab_id = '$LAB_ID' order by 1, r.kind"
expect "exactly the two failing files are flagged" "$(open_flags)" "Bradford_2026-11-04.xlsx curve_fit 0.8762 v2
plate8_A595_endpoint.csv control 0.225 v2"
expect "nothing tied to no protocol is checked" \
  "$(q "select count(*) from check_results r join file_locations fl on fl.sha256 = r.sha256 where fl.original_name like 'spectrum%'")" "0"
expect "every flag cites its version, file and cells" \
  "$(q "select count(*) from flags where lab_id = '$LAB_ID' and protocol_version_id is not null and source_sheet is not null and not isempty(source_rows) and cardinality(source_columns) > 0")" "2"
expect "the plate's flag names its blanks" \
  "$(q "select control_sheet || ' ' || array_to_string(control_columns, ',') || ' ' || control_rows::text from flags where lab_id = '$LAB_ID' and kind = 'control'")" \
  "Table 1 B,C {[0,3)}"

echo "== a member answers, and the routes' core reads the flags"
CURVE_FLAG="$(q "select id from flags where lab_id = '$LAB_ID' and kind = 'curve_fit'")"
as_member "select review from review_flag('$CURVE_FLAG', 'useful', 'The 750 standard looks short')" >/dev/null
cd "$ROOT/apps/web"
E2E_DATABASE_URL="$DATABASE_URL" E2E_USER="$USER_ID" E2E_LAB="$LAB_ID" \
  pnpm exec vitest run --project unit src/lib/__tests__/flag-e2e.test.ts
cd "$ROOT/workers"

echo "== loosening the curve's range saves version 3 and clears that flag"
V2="$(q "select current_version_id from protocols where id = '$PROTOCOL'")"
LOOSER="$(echo "$CHECKS" | sed 's/"min": 0.98/"min": 0.8/')"
as_member "select version from save_checks('$PROTOCOL', '$V2', '$LOOSER'::jsonb, 'Looser while the reader is serviced')" >/dev/null
wait_settled
expect "only the plate stays flagged, still citing v2" "$(open_flags)" "plate8_A595_endpoint.csv control 0.225 v2"
expect "the curve's flag was cleared, its answer kept" \
  "$(q "select cleared_reason || ' / ' || review from flags where id = '$CURVE_FLAG'")" "It passes now. / useful"
expect "audit rows" "$(q "select string_agg(action::text || ':' || n, ' ' order by action::text) from (select action, count(*) n from audit_log where lab_id = '$LAB_ID' and action::text in ('check.save', 'flag.review') group by 1) a")" \
  "check.save:2 flag.review:1"
echo "passed"
