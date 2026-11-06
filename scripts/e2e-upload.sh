#!/usr/bin/env bash
# Uploads a gel photo and a PDF through the upload routes' cores on local Postgres and a local
# object store, the way the upload page does: start, PUT the bytes to the store (here the local
# store's stand-in for R2's presigned PUT), then complete, which checks the size and sha256.
# Then runs the real worker until both are indexed and labeled, and shows the labels and
# searches as the uploader. Supabase's HTTP layer and R2 itself are the parts not exercised.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB=${E2E_UPLOAD_DB:-binary_labs_e2e_upload}
export DATABASE_URL="postgresql://localhost/$DB"
export PREVIEW_STORE=local
export PREVIEW_DIR=.data/e2e-store
export TOKEN_ENCRYPTION_KEY="${TOKEN_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
# Rules-only labels unless a key is passed in on purpose; workers/.env is never read here.
export ANTHROPIC_API_KEY="${E2E_ANTHROPIC_API_KEY:-}"
FILES="$ROOT/workers/.data/e2e-upload"
USER_ID=00000000-0000-0000-0000-0000000000e3
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

as_member() {
  psql -qtAX -v ON_ERROR_STOP=1 -d "$DB" \
    -c "set role authenticated" -c "set request.jwt.claim.sub = '$USER_ID'" -c "$1"
}

dropdb --if-exists "$DB" && createdb "$DB"
cd "$ROOT/workers"
rm -rf "$PREVIEW_DIR" "$FILES" && mkdir -p "$FILES"
uv run bl migrate --test-stub
uv run python - "$FILES" <<'PY'
import sys
from pathlib import Path
from bl_worker import samples
out = Path(sys.argv[1])
# A phone camera input hands over a photo without an EXIF capture time.
(out / "gel batch 5.jpg").write_bytes(samples.gel_jpeg(seed=5, make="Apple", model="iPhone 15", taken=""))
(out / "elution notes.pdf").write_bytes(samples.pdf(["Ni-NTA elution of P450 BM3 batch 5", "250 mM imidazole, 4 x 1 mL fractions"]))
PY

psql -qtAX -d "$DB" -c "insert into auth.users (id, email, raw_user_meta_data) values ('$USER_ID', 'priya@lab.test', '{\"full_name\": \"Priya Nair\"}')"
LAB_ID="$(as_member "select create_lab('Upload E2E lab')" | tail -1)"
echo "lab $LAB_ID"

cd "$ROOT/apps/web"
E2E_DATABASE_URL="$DATABASE_URL" E2E_USER="$USER_ID" E2E_LAB="$LAB_ID" E2E_EXPERIMENT="P450 BM3" \
  E2E_FILES="$FILES/gel batch 5.jpg,$FILES/elution notes.pdf" \
  pnpm exec vitest run --project unit src/lib/__tests__/upload-e2e.test.ts

echo "== stored objects (staging copies under uploads/ are gone once recorded)"
(cd "$ROOT/workers/$PREVIEW_DIR" && find . -type f | sort)

cd "$ROOT/workers"
uv run bl worker > "$ROOT/workers/.data/e2e-upload-worker.log" 2>&1 & PIDS+=($!)
start=$(date +%s)
while :; do
  read -r unsettled labeled <<< "$(as_member "select count(*) filter (where index_state = 'pending' or (index_state = 'indexed' and label is null)), count(*) filter (where label is not null) from my_uploads('$LAB_ID')" | tail -1 | tr '|' ' ')"
  echo "unsettled $unsettled  labeled $labeled"
  (( unsettled == 0 && labeled == 2 )) && break
  (( $(date +%s) - start > 600 )) && { echo "uploads did not settle in 10 min"; exit 1; }
  sleep 3
done
echo "settled $(( $(date +%s) - start ))s after the worker started"

echo "== my uploads"
as_member "select name, path, index_state, label ->> 'clean_name', label ->> 'status', label -> 'person' ->> 'name', label ->> 'date', label -> 'experiment' ->> 'name' from my_uploads('$LAB_ID')"
echo "== search (keyword)"
for q in "P450 BM3 gel" "imidazole" "Priya"; do
  echo "-- $q"
  as_member "select locations -> 0 ->> 'path', locations -> 0 ->> 'source_kind', label ->> 'clean_name' from search_files('$LAB_ID', '$q') limit 3"
done
echo "== audit"
as_member "select action, target from audit_log where lab_id = '$LAB_ID' order by id" || true
