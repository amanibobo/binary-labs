#!/usr/bin/env bash
# Writes the ~50-file sample lab, scans it with the real worker on local Postgres and a local
# store, and waits for the worker's similar-in-meaning cache (file_vectors, file_neighbors) to
# settle. Then, as a member with RLS on, reads the lab map's three views and checks that a
# second lab's member is refused. Embeddings use the hash embedder unless E2E_EMBED_MODEL is
# set (Qwen/Qwen3-Embedding-0.6B for the real one); labels come from the rules only. Cleans up
# after itself unless E2E_KEEP is set.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB="${E2E_DB:-binary_labs_e2e_map}"
export DATABASE_URL="postgresql://localhost/$DB"
export PREVIEW_STORE=local
export PREVIEW_DIR=.data/e2e-map-store
export EMBED_MODEL="${E2E_EMBED_MODEL:-hash-1024}"
export TOKEN_ENCRYPTION_KEY="${TOKEN_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
DIR="$ROOT/workers/.data/e2e-map"
USER_ID=00000000-0000-4000-8000-0000000000e9
OTHER_ID=00000000-0000-4000-8000-0000000000ea
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  if [[ -z "${E2E_KEEP:-}" ]]; then
    dropdb --if-exists --force "$DB" 2>/dev/null || true
    rm -rf "$ROOT/workers/$PREVIEW_DIR" "$DIR"
  fi
}
trap cleanup EXIT

as_user() {
  psql -qtAX -v ON_ERROR_STOP=1 -d "$DB" \
    -c "set role authenticated" -c "set request.jwt.claim.sub = '$1'" -c "$2"
}

dropdb --if-exists --force "$DB" && createdb "$DB"
cd "$ROOT/workers"
rm -rf "$PREVIEW_DIR" "$DIR" && mkdir -p "$DIR"
uv run python scripts/make_sample_lab.py "$DIR/lab" > /dev/null
uv run bl migrate --test-stub

psql -qtAX -d "$DB" -c "insert into auth.users (id, email) values ('$USER_ID', 'e2e-map@lab.test'), ('$OTHER_ID', 'e2e-other@lab.test')"
LAB_ID="$(as_user "$USER_ID" "select create_lab('Map E2E lab')" | tail -1)"
OTHER_LAB="$(as_user "$OTHER_ID" "select create_lab('Another lab')" | tail -1)"
echo "lab $LAB_ID"
# What the lab already knows, so Tier 1 rules label files with experiments and people.
as_user "$USER_ID" "insert into experiments (lab_id, name, aliases) values
  ('$LAB_ID', 'P450 BM3', '{P450}'), ('$LAB_ID', 'Lysozyme', '{lysozyme}'), ('$LAB_ID', 'Thermal shift screen', '{thermal_shift}');
  insert into people (lab_id, display_name, aliases) values
  ('$LAB_ID', 'Ade Bello', '{AB}'), ('$LAB_ID', 'Chen Dai', '{CD}'), ('$LAB_ID', 'Eva Fischer', '{EF}')" > /dev/null

START=$(date +%s)
uv run bl worker > "$DIR/worker.log" 2>&1 & PIDS+=($!)
uv run bl scan-local "$LAB_ID" "$DIR/lab"

# Settled: every file indexed, and no vector or list waiting.
while :; do
  row="$(psql -qtAX -d "$DB" -c "
    select (select count(*) filter (where index_state = 'pending') from file_locations where lab_id = '$LAB_ID'),
      (select count(*) from file_locations where lab_id = '$LAB_ID'),
      (select count(*) from file_vectors where lab_id = '$LAB_ID'
        and (computed_at is null or computed_at < chunks_changed_at or listed_at is distinct from computed_at)),
      (select count(*) from file_vectors where lab_id = '$LAB_ID'),
      (select count(*) from file_neighbors where lab_id = '$LAB_ID'),
      (select count(distinct sha256) from file_locations where lab_id = '$LAB_ID' and sha256 is not null)
        - (select count(*) from labels where lab_id = '$LAB_ID')")"
  IFS='|' read -r pending files stale vectors lists unlabeled <<< "$row"
  echo "files $files, pending $pending, unlabeled $unlabeled; vectors $vectors, stale $stale; neighbor rows $lists"
  [[ "$files" -gt 0 && "$pending" == 0 && "$unlabeled" == 0 && "$vectors" -gt 0 && "$stale" == 0 && "$lists" -gt 0 ]] && break
  (( $(date +%s) - START > 300 )) && { echo "the map's neighbors did not settle in 5 min"; exit 1; }
  sleep 3
done
echo "settled $(( $(date +%s) - START ))s after the worker started"
# A protocol with the SDS-PAGE file attached, as a member would start one from it.
SDS="$(psql -qtAX -d "$DB" -c "select sha256 from file_locations where lab_id = '$LAB_ID' and original_name = 'SDS-PAGE_protocol.pdf' limit 1")"
as_user "$USER_ID" "select protocol_id from create_protocol('$LAB_ID', 'protocol', 'SDS-PAGE', 'Run at 150 V.', null, '$SDS')" > /dev/null
grep -h "neighbors in lab" "$DIR/worker.log" | sed 's/^.*neighbors in lab [^:]*: /refresh: /' || true

echo "== nearest pairs the worker kept"
psql -qtAX -d "$DB" -c "
  select round(n.similarity::numeric, 3), a.path, b.path from file_neighbors n
  join lateral (select path from file_locations where lab_id = n.lab_id and sha256 = n.sha256 order by path limit 1) a on true
  join lateral (select path from file_locations where lab_id = n.lab_id and sha256 = n.neighbor order by path limit 1) b on true
  where n.lab_id = '$LAB_ID' and n.sha256 < n.neighbor order by 1 desc limit 8"

echo "== the map, as the member"
as_user "$USER_ID" "select jsonb_array_length(m -> 'hubs') || ' hubs, ' || jsonb_array_length(m -> 'links') || ' links, '
  || (m ->> 'files') || ' files, ' || octet_length(m::text) || ' bytes' from lab_map('$LAB_ID') m"
HUB="$(as_user "$USER_ID" "select h ->> 'id' from jsonb_array_elements(lab_map('$LAB_ID') -> 'hubs') h order by (h ->> 'files')::int desc limit 1")"
as_user "$USER_ID" "select '$HUB: ' || jsonb_array_length(m -> 'nodes') || ' files, '
  || (select count(*) from jsonb_array_elements(m -> 'edges') e where e ->> 'kind' = 'similar') || ' similar pairs'
  from lab_map_hub('$LAB_ID', '$HUB', 400, true) m"
FILE="$(psql -qtAX -d "$DB" -c "select 'file:' || sha256 from file_neighbors where lab_id = '$LAB_ID' group by 1 order by count(*) desc, 1 limit 1")"
for depth in 1 2; do
  as_user "$USER_ID" "select 'around $FILE, depth $depth, similar on: ' || jsonb_array_length(m -> 'nodes') || ' nodes, '
    || jsonb_array_length(m -> 'edges') || ' edges' from lab_map_local('$LAB_ID', '$FILE', $depth, true) m"
done

echo "== another lab's member"
if as_user "$OTHER_ID" "select lab_map('$LAB_ID')" 2> "$DIR/refused.txt"; then
  echo "another lab read this lab's map"; exit 1
fi
grep -o "not a member of this lab" "$DIR/refused.txt"
as_user "$OTHER_ID" "select 'their own map: ' || jsonb_array_length(lab_map('$OTHER_LAB') -> 'hubs') || ' hubs'"
as_user "$OTHER_ID" "select 'neighbor rows they can read: ' || count(*) from file_neighbors"
