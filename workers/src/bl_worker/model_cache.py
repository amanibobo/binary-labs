"""Model answers cached in model_calls by (lab, sha256, purpose, model, prompt version):
re-running a job converges without paying twice, and the table is the cost ledger."""

from __future__ import annotations

import logging
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from bl_worker.models import ModelRequest, Models

log = logging.getLogger(__name__)


def cached_call(
    conn: psycopg.Connection,
    models: Models | None,
    lab_id: UUID,
    sha256: str,
    purpose: str,
    request: ModelRequest,
    version: int,
    *,
    call_models: bool = True,
) -> str | None:
    """The model's JSON text for this blob in this lab, from the cache or from one new call."""
    key = (lab_id, sha256, purpose, request.model, version)
    row = conn.execute(
        "select output from model_calls where lab_id = %s and sha256 = %s and purpose = %s"
        " and model = %s and prompt_version = %s",
        key,
    ).fetchone()
    if row is not None:
        return row[0].get("text")
    if models is None or not call_models:
        return None
    reply = models.call(request)
    cost = reply.usage.cost_usd(request.model)
    conn.execute(
        "insert into model_calls (lab_id, sha256, purpose, model, prompt_version, output,"
        " input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)"
        " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) on conflict do nothing",
        (
            *key,
            Jsonb({"text": reply.text, "stop_reason": reply.stop_reason}),
            reply.usage.input_tokens,
            reply.usage.output_tokens,
            reply.usage.cache_read_tokens,
            reply.usage.cache_write_tokens,
            cost,
        ),
    )
    (total,) = conn.execute(
        "select coalesce(sum(cost_usd), 0) from model_calls where lab_id = %s", (lab_id,)
    ).fetchone()  # type: ignore[misc]
    log.info(
        "model %s %s for %s: in %d (cache read %d, write %d), out %d tokens, $%s;"
        " lab %s running total $%s",
        request.model,
        purpose,
        sha256[:12],
        reply.usage.input_tokens,
        reply.usage.cache_read_tokens,
        reply.usage.cache_write_tokens,
        reply.usage.output_tokens,
        cost,
        lab_id,
        total,
    )
    return reply.text
