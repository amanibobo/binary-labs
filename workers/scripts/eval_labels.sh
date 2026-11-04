#!/bin/sh
# Rebuilds a local database from scratch, scans and labels the sample lab with the worker,
# and scores the labels. Reads ANTHROPIC_API_KEY from the environment; without one, labels
# come from Tier 1 rules alone.
#   ANTHROPIC_API_KEY=... sh scripts/eval_labels.sh [db_name]
set -eu
cd "$(dirname "$0")/.."
DB=${1:-binary_labs_labels}
export DATABASE_URL="postgresql://localhost/$DB" PREVIEW_STORE=local
export PREVIEW_DIR="$PWD/../.data/eval-previews" EMBED_MODEL=${EMBED_MODEL:-Qwen/Qwen3-Embedding-0.6B}
dropdb --if-exists --force "$DB" && createdb "$DB"
uv run bl migrate --test-stub
uv run python scripts/make_sample_lab.py ../.data/sample-lab
uv run bl sample-lab ../.data/sample-lab
while [ "$(psql -d "$DB" -Atc "select count(*) from procrastinate_jobs where status = 'todo'")" != 0 ]; do
  uv run bl worker --concurrency 4 --until-idle
done
uv run bl eval-labels "$DATABASE_URL"
