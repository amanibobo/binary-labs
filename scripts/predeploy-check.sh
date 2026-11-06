#!/usr/bin/env bash
# Everything that should pass before a deploy, on this machine, touching no hosted service:
# typecheck, lint and tests for the app, the landing page and the worker; the production
# builds; the env templates against what the code reads; and the worker image if Docker is
# here. Tests use local Postgres 17 with their own databases. docs/deploy.md runs this first.
#
#   scripts/predeploy-check.sh            # all of it
#   SKIP_DB=1 scripts/predeploy-check.sh  # without the tests that need local Postgres
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
# Their own database names, so this can run beside another checkout's tests.
export BL_WEB_TEST_DB="${BL_WEB_TEST_DB:-binary_labs_predeploy_web}"
export BL_TEST_DB="${BL_TEST_DB:-binary_labs_predeploy_worker}"
# A deploy's variables must not leak in from the shell: the builds here are checked without them.
unset VERCEL_ENV BINARY_ENV TEST_DATABASE_URL

step() { printf '\n== %s\n' "$1"; }

step "env templates match what the code reads"
landing_reads="$(grep -rhoE 'process\.env\.[A-Z][A-Z0-9_]*' "$ROOT/apps/landing/app" | sed 's/process\.env\.//' | sort -u)"
landing_lists="$(grep -oE '^[A-Z][A-Z0-9_]*=' "$ROOT/apps/landing/.env.production.example" | tr -d '=' | sort -u)"
if [[ "$landing_reads" != "$landing_lists" ]]; then
  echo "apps/landing/.env.production.example lists [$landing_lists] but the code reads [$landing_reads]"
  exit 1
fi
echo "landing: $landing_lists"
# The app's and the worker's templates are checked by tests that run below:
# apps/web/src/app/__tests__/env-templates.test.ts and workers/tests/test_env_template.py.

step "app: install, typecheck, lint, unit tests"
cd "$ROOT/apps/web"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
if [[ -z "${SKIP_DB:-}" ]]; then
  step "app: database tests ($BL_WEB_TEST_DB)"
  pnpm test:db
fi

step "app: a production deploy with missing variables stops at build"
if out="$(VERCEL_ENV=production NEXT_PUBLIC_SUPABASE_URL= pnpm exec next build 2>&1)"; then
  echo "next build went ahead without production variables"
  exit 1
fi
grep -q "Binary's environment isn't ready for production" <<<"$out" || { echo "$out" | tail -20; exit 1; }
echo "stopped, listing: $(grep -c '^  - ' <<<"$out") variables"

step "app: production build"
pnpm build
# Fixture pages are *.dev.tsx, which only `next dev` routes (next.config.ts); none may ship.
if find .next/server/app -path '*dev/fixtures*' | grep -q .; then
  echo "a fixture page is in the production build"
  exit 1
fi
echo "no fixture pages in the build"

step "landing: install, typecheck, lint, production build"
cd "$ROOT/apps/landing"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build

step "worker: lint and tests"
cd "$ROOT/workers"
uv run --frozen ruff check
uv run --frozen ruff format --check
if [[ -z "${SKIP_DB:-}" ]]; then
  uv run --frozen pytest -q
else
  uv run --frozen pytest -q tests/test_config.py tests/test_embed_api.py tests/test_env_template.py tests/test_chunking.py
fi

step "worker: the production image's dependencies import without torch"
uv run --isolated --frozen --no-default-groups python -c "
import importlib.util
import bl_worker.cli, bl_worker.jobs, bl_worker.runtime
assert importlib.util.find_spec('torch') is None, 'torch is in the production dependencies'
print('imports fine; no torch')"

if command -v docker >/dev/null 2>&1; then
  free_gb="$(df -g / | awk 'NR==2 {print $4}')"
  if (( free_gb >= 5 )); then
    step "worker: image"
    docker build -f "$ROOT/workers/Dockerfile" -t binary-worker:predeploy "$ROOT"
    docker image ls binary-worker:predeploy --format '{{.Repository}}:{{.Tag}} {{.Size}}'
  else
    step "worker: image skipped, only ${free_gb} GB free"
  fi
else
  step "worker: image skipped, no Docker here"
fi

printf '\nAll checks passed.\n'
