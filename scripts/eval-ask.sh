#!/usr/bin/env bash
# The ask eval: builds the sample lab on local Postgres with the real worker (Qwen embeddings,
# labels from the rules alone, so the build costs nothing), adds two protocol pages, serves
# /embed, then asks every question in workers/evals/ask_expected.json with the real model and
# scores the answers. Needs ANTHROPIC_API_KEY in the environment. Writes the results to
# .data/ask-eval.json and drops the database after, unless EVAL_KEEP is set.
#   ANTHROPIC_API_KEY=... bash scripts/eval-ask.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB=${BL_EVAL_DB:-binary_labs_ask_eval}
STORE="$ROOT/.data/ask-eval-store"
PORT=${EVAL_EMBED_PORT:-8797}
KEY="${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY}"
EMBED_KEY="eval-$(openssl rand -hex 12)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  if [[ -z "${EVAL_KEEP:-}" ]]; then
    dropdb --if-exists --force "$DB" 2>/dev/null || true
    rm -rf "$STORE" "$ROOT/.data/sample-lab"
  fi
}
trap cleanup EXIT

cd "$ROOT/workers"
# The worker never sees the model key: labels come from the rules, and only the questions pay.
export DATABASE_URL="postgresql://localhost/$DB" PREVIEW_STORE=local PREVIEW_DIR="$STORE"
unset ANTHROPIC_API_KEY
dropdb --if-exists --force "$DB" && createdb "$DB"
uv run bl migrate --test-stub
uv run python scripts/make_sample_lab.py ../.data/sample-lab
uv run bl sample-lab ../.data/sample-lab
start=$(date +%s)
while [ "$(psql -d "$DB" -Atc "select count(*) from procrastinate_jobs where status = 'todo'")" != 0 ]; do
  uv run bl worker --concurrency 4 --until-idle
done
echo "sample lab built in $(( $(date +%s) - start ))s"

ADMIN=$(psql -d "$DB" -Atc "select user_id from members where role = 'admin' limit 1")
LAB=$(psql -d "$DB" -Atc "select lab_id from members where role = 'admin' limit 1")
as_admin() {
  psql -qtAX -v ON_ERROR_STOP=1 -d "$DB" -c "set role authenticated" -c "set request.jwt.claim.sub = '$ADMIN'" -c "$1"
}
as_admin "select create_protocol('$LAB', 'protocol', 'SDS-PAGE (Bis-Tris, 12%)', E'1. Mix 15 uL sample with 5 uL 4x Laemmli buffer and 5% beta-mercaptoethanol.\n2. Heat at 95 C for 5 min, then spin down for 1 min.\n3. Load 10 uL per lane, with the PageRuler ladder in lane 1.\n4. Run at 150 V for 45 min in MES running buffer.\n5. Stain with Coomassie for 1 h and destain overnight.')" > /dev/null
as_admin "select create_protocol('$LAB', 'protocol', 'Ni-NTA purification of P450 BM3', E'1. Equilibrate a 5 mL HisTrap with 10 CV lysis buffer.\n2. Load the clarified lysate at 1 mL/min.\n3. Wash with 20 mM imidazole for 15 CV.\n4. Elute with a 20-250 mM imidazole gradient over 20 CV, collecting 1 mL fractions.\n5. Pool the red fractions and dialyse into 50 mM KPi pH 7.5 overnight.')" > /dev/null

EMBED_API_KEY="$EMBED_KEY" EMBED_PORT="$PORT" uv run bl serve-embed > "$ROOT/.data/ask-eval-embed.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 120); do
  if curl -s -o /dev/null -X POST -H "authorization: Bearer $EMBED_KEY" -H 'content-type: application/json' -d '{"text":"warm up"}' "http://localhost:$PORT/embed"; then break; fi
  sleep 1
done

cd "$ROOT/apps/web"
EVAL_DATABASE_URL="postgresql://localhost/$DB" EVAL_STORE="$STORE" EVAL_OUT="$ROOT/.data/ask-eval.json" \
  EMBED_URL="http://localhost:$PORT/embed" EMBED_API_KEY="$EMBED_KEY" ANTHROPIC_API_KEY="$KEY" \
  pnpm exec vitest run --project unit src/lib/__tests__/ask.eval.test.ts
