"""The one interface every model call goes through, so models can be swapped as prices change.

`AnthropicModels` calls the Claude API; `FakeModels` answers from a function, for tests.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal, Protocol

from pydantic import BaseModel

log = logging.getLogger(__name__)

TIER2_MODEL = "claude-haiku-5-5"
TIER3_MODEL = "claude-sonnet-5-5"

# Dollars per million tokens. Cache writes cost 1.25x input and cache reads 0.1x; both are
# estimates, since the logs only need a running figure, not an invoice.
PRICES: dict[str, tuple[Decimal, Decimal]] = {
    TIER2_MODEL: (Decimal("0.10"), Decimal("0.50")),
    TIER3_MODEL: (Decimal("2.00"), Decimal("10.00")),
}

Effort = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class Image:
    data: bytes
    media_type: str


@dataclass(frozen=True)
class ModelRequest:
    model: str
    # The stable prefix: instructions, then the lab's context. Cached between files.
    system: tuple[str, ...]
    content: tuple[str | Image, ...]
    schema: type[BaseModel]
    effort: Effort = "low"
    max_tokens: int = 4000


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def cost_usd(self, model: str) -> Decimal:
        price_in, price_out = PRICES.get(model, (Decimal(0), Decimal(0)))
        per_token_in = price_in / 1_000_000
        return (
            self.input_tokens * per_token_in
            + self.cache_write_tokens * per_token_in * Decimal("1.25")
            + self.cache_read_tokens * per_token_in * Decimal("0.1")
            + self.output_tokens * price_out / 1_000_000
        ).quantize(Decimal("0.000001"))


@dataclass(frozen=True)
class ModelReply:
    # The JSON text, or None when the model declined or ran out of tokens.
    text: str | None
    usage: Usage
    stop_reason: str


class Models(Protocol):
    def call(self, request: ModelRequest) -> ModelReply: ...


class AnthropicModels:
    def __init__(self, api_key: str, *, timeout: float = 60.0) -> None:
        import anthropic

        self._anthropic = anthropic
        self._client = anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=3)

    def call(self, request: ModelRequest) -> ModelReply:
        system = [{"type": "text", "text": text} for text in request.system]
        system[-1]["cache_control"] = {"type": "ephemeral"}
        params = {
            "model": request.model,
            "max_tokens": request.max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": [_part(p) for p in request.content]}],
            "output_config": {
                "effort": request.effort,
                "format": {
                    "type": "json_schema",
                    "schema": self._anthropic.transform_schema(request.schema),
                },
            },
        }
        if request.model == TIER3_MODEL:
            response = self._client.beta.messages.create(
                **params, betas=["server-side-fallback-2026-07-01"], fallbacks="default"
            )
        else:
            response = self._client.messages.create(**params)
        u = response.usage
        usage = Usage(
            input_tokens=u.input_tokens,
            output_tokens=u.output_tokens,
            cache_read_tokens=u.cache_read_input_tokens or 0,
            cache_write_tokens=u.cache_creation_input_tokens or 0,
        )
        text = next((b.text for b in response.content if b.type == "text"), None)
        if response.stop_reason != "end_turn":
            log.warning("model %s stopped with %s", request.model, response.stop_reason)
            text = None
        return ModelReply(text, usage, response.stop_reason or "unknown")


def _part(part: str | Image) -> dict:
    if isinstance(part, str):
        return {"type": "text", "text": part}
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": part.media_type,
            "data": base64.standard_b64encode(part.data).decode(),
        },
    }


@dataclass
class FakeModels:
    """Answers each request with `answer(request)`, a JSON string or None, and records it."""

    answer: Callable[[ModelRequest], str | None]
    calls: list[ModelRequest] = field(default_factory=list)

    def call(self, request: ModelRequest) -> ModelReply:
        self.calls.append(request)
        text = self.answer(request)
        usage = Usage(input_tokens=1000, output_tokens=100)
        return ModelReply(text, usage, "end_turn" if text is not None else "refusal")


def build_models(api_key: str | None) -> Models | None:
    """None when there is no key: labeling then runs on Tier 1 rules alone."""
    return AnthropicModels(api_key) if api_key else None
