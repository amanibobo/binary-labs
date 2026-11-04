from __future__ import annotations

from dataclasses import dataclass

from psycopg_pool import ConnectionPool

from bl_worker.config import Settings
from bl_worker.db import configure
from bl_worker.embed import Embedder, build_embedder
from bl_worker.models import Models, build_models
from bl_worker.previews import PreviewStore, build_preview_store


@dataclass(frozen=True)
class Runtime:
    """What every job needs, built once per worker process."""

    settings: Settings
    pool: ConnectionPool
    embedder: Embedder
    previews: PreviewStore
    # None without ANTHROPIC_API_KEY: labels then come from Tier 1 rules alone.
    models: Models | None = None

    def close(self) -> None:
        self.pool.close()


def open_pool(url: str, max_size: int) -> ConnectionPool:
    # Autocommit, so each processing step commits on its own and a crash keeps what's done.
    return ConnectionPool(
        url,
        min_size=1,
        max_size=max_size,
        kwargs={"autocommit": True},
        configure=configure,
        open=True,
    )


def build_runtime(
    settings: Settings,
    *,
    embedder: Embedder | None = None,
    previews: PreviewStore | None = None,
    models: Models | None = None,
    pool_size: int = 6,
) -> Runtime:
    key = settings.anthropic_api_key
    return Runtime(
        settings=settings,
        pool=open_pool(settings.database_url, pool_size),
        embedder=embedder or build_embedder(settings.embed_model),
        previews=previews or build_preview_store(settings),
        models=models or build_models(key.get_secret_value() if key else None),
    )
