"""Speech to text for talk-throughs, behind one interface chosen by `TRANSCRIBER`
(decisions.md, "speech-to-text: ElevenLabs, with local Whisper as the alternative").

`ElevenLabsTranscriber` calls Scribe; `WhisperTranscriber` runs faster-whisper on this machine
(`uv sync --extra whisper`); `FakeTranscriber` answers from a function, for tests. A transcript
is stored as an extraction named after the transcriber, so it's cached per audio file.
"""

from __future__ import annotations

import io
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Protocol

import httpx
from pydantic import BaseModel, ValidationError

from bl_worker.config import Settings
from bl_worker.domain import ExtractionKind
from bl_worker.extract import Extracted, ExtractionFailed, clean_text

log = logging.getLogger(__name__)

SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text"
SCRIBE_MODEL = "scribe_v2"
# Scribe v2 batch, every plan tier (elevenlabs.io/pricing/api, November 2026).
SCRIBE_USD_PER_HOUR = Decimal("0.22")
SCRIBE_ATTEMPTS = 3
# Scribe answers once the whole file is transcribed; 30 minutes of speech can take minutes.
SCRIBE_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=120.0, pool=10.0)


@dataclass(frozen=True)
class Transcript:
    text: str
    duration_s: float | None
    language: str | None
    cost_usd: Decimal


class TranscriptionFailed(ExtractionFailed):
    """The audio couldn't be transcribed; the recording's location fails with this message,
    which the talk-through page shows beside Retry."""


class Transcriber(Protocol):
    # Name and version key the cached extraction: a different transcriber transcribes again.
    name: str
    version: int

    def transcribe(self, audio: bytes, mime: str) -> Transcript: ...


class ScribeResponse(BaseModel):
    text: str
    language_code: str | None = None
    audio_duration_secs: float | None = None


def _scribe_message(response: httpx.Response) -> str:
    try:
        detail: Any = response.json().get("detail")
    except ValueError:
        detail = None
    if isinstance(detail, dict):
        detail = detail.get("message") or detail.get("status")
    elif isinstance(detail, list) and detail:
        detail = detail[0].get("msg") if isinstance(detail[0], dict) else detail[0]
    return f"ElevenLabs answered {response.status_code}" + (f": {detail}" if detail else "")


class ElevenLabsTranscriber:
    version = 1

    def __init__(
        self,
        api_key: str,
        *,
        model: str = SCRIBE_MODEL,
        client: httpx.Client | None = None,
        backoff: Callable[[int], float] = lambda attempt: 2.0 * 3**attempt,
    ) -> None:
        self.name = f"elevenlabs/{model}"
        self._model = model
        self._key = api_key
        self._client = client or httpx.Client(timeout=SCRIBE_TIMEOUT)
        self._backoff = backoff

    def transcribe(self, audio: bytes, mime: str) -> Transcript:
        for attempt in range(SCRIBE_ATTEMPTS):
            try:
                response = self._client.post(
                    SCRIBE_URL,
                    headers={"xi-api-key": self._key},
                    data={"model_id": self._model, "tag_audio_events": "false", "diarize": "false"},
                    files={"file": ("talk-through", audio, mime)},
                )
            except httpx.TransportError as e:
                failure = f"Couldn't reach ElevenLabs: {type(e).__name__}"
            else:
                if response.status_code == 200:
                    return self._parse(response)
                failure = _scribe_message(response)
                # A 4xx other than rate limiting is about this request; asking again won't help.
                if response.status_code < 500 and response.status_code != 429:
                    raise TranscriptionFailed(failure)
            if attempt + 1 < SCRIBE_ATTEMPTS:
                log.warning("transcription attempt %d failed: %s", attempt + 1, failure)
                time.sleep(self._backoff(attempt))
        raise TranscriptionFailed(failure)

    def _parse(self, response: httpx.Response) -> Transcript:
        try:
            body = ScribeResponse.model_validate_json(response.content)
        except ValidationError as e:
            raise TranscriptionFailed(f"ElevenLabs sent an answer we can't read: {e}") from e
        duration = body.audio_duration_secs
        cost = (
            (Decimal(str(duration)) * SCRIBE_USD_PER_HOUR / 3600).quantize(Decimal("0.000001"))
            if duration is not None
            else Decimal(0)
        )
        return Transcript(body.text, duration, body.language_code, cost)


class WhisperTranscriber:
    """faster-whisper on this machine: audio never leaves it, and it costs nothing per minute."""

    version = 1

    def __init__(self, model: str = "small") -> None:
        self.name = f"whisper/{model}"
        self._size = model
        self._model: Any = None
        self._lock = threading.Lock()

    def transcribe(self, audio: bytes, mime: str) -> Transcript:
        try:
            with self._lock:
                if self._model is None:
                    from faster_whisper import WhisperModel

                    self._model = WhisperModel(self._size, compute_type="int8")
                segments, info = self._model.transcribe(io.BytesIO(audio), vad_filter=True)
                text = " ".join(s.text.strip() for s in segments)
        except ImportError as e:
            raise TranscriptionFailed(
                "Local Whisper isn't installed on this worker (uv sync --extra whisper)."
            ) from e
        except Exception as e:
            raise TranscriptionFailed(f"Whisper couldn't read this audio: {e}") from e
        return Transcript(text, info.duration, info.language, Decimal(0))


@dataclass
class FakeTranscriber:
    """Answers with `answer(audio)` and records each call."""

    answer: Callable[[bytes], str]
    name: str = "fake"
    version: int = 1
    calls: list[bytes] = field(default_factory=list)

    def transcribe(self, audio: bytes, mime: str) -> Transcript:
        self.calls.append(audio)
        return Transcript(self.answer(audio), 42.0, "en", Decimal("0.0025"))


@dataclass(frozen=True)
class Unconfigured:
    """Stands in when the chosen transcriber has no credentials, so other files still index
    and a talk-through fails with a message saying what's missing."""

    reason: str
    name: str = "unconfigured"
    version: int = 1

    def transcribe(self, audio: bytes, mime: str) -> Transcript:
        raise TranscriptionFailed(self.reason)


class TranscriptExtractor:
    """A transcriber as the extractor registry sees it."""

    def __init__(self, transcriber: Transcriber, mime: str) -> None:
        self.transcriber = transcriber
        self.name = transcriber.name
        self.version = transcriber.version
        self.mime = mime

    def extract(self, data: bytes) -> Extracted:
        t = self.transcriber.transcribe(data, self.mime)
        return Extracted(
            ExtractionKind.TRANSCRIPT,
            clean_text(t.text.strip()),
            {"duration_s": t.duration_s, "language": t.language, "cost_usd": str(t.cost_usd)},
        )


def build_transcriber(settings: Settings) -> Transcriber:
    match settings.transcriber:
        case "elevenlabs":
            key = settings.elevenlabs_api_key
            if key is None:
                return Unconfigured(
                    "Speech-to-text isn't set up on this worker (ELEVENLABS_API_KEY)."
                )
            return ElevenLabsTranscriber(key.get_secret_value())
        case "whisper":
            return WhisperTranscriber(settings.whisper_model)
