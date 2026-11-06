# The worker (`bl worker`) for Fly.io. Build from the repo root, which holds db/migrations:
#   docker build -f workers/Dockerfile -t binary-worker .
# No torch: production embeds through the embedding service (EMBEDDER=remote, modal_embed.py),
# so the image carries only what jobs need. docs/deploy.md has the Fly steps.

FROM ghcr.io/astral-sh/uv:0.10.2 AS uv
# A static ffmpeg build: one binary instead of Debian's ffmpeg package and its libraries.
FROM mwader/static-ffmpeg:9.0.2 AS ffmpeg

FROM python:3.12-slim-bookworm AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
# Laid out as in the repo: config.py finds db/ beside workers/.
WORKDIR /app/workers
COPY workers/pyproject.toml workers/uv.lock ./
# Dependencies first, so a code change doesn't reinstall them. --no-default-groups leaves out
# dev and local-embed (sentence-transformers, torch).
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-default-groups --no-install-project
COPY workers/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-default-groups

FROM python:3.12-slim-bookworm
RUN useradd --create-home --uid 1000 worker
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=build /app/workers /app/workers
COPY db /app/db
ENV PATH="/app/workers/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    BINARY_ENV=production \
    EMBEDDER=remote
WORKDIR /app/workers
USER worker
CMD ["bl", "worker", "--concurrency", "4"]
