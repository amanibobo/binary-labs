from __future__ import annotations

import base64
import importlib.util
import shutil
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlparse

from pydantic import BeforeValidator, SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

WORKERS_DIR = Path(__file__).resolve().parents[2]


def _decode_key(value: object) -> object:
    if not isinstance(value, str):
        return value
    key = base64.b64decode(value, validate=True)
    if len(key) != 32:
        raise ValueError("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded")
    return key


EncryptionKey = Annotated[bytes, BeforeValidator(_decode_key)]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=WORKERS_DIR / ".env",
        env_ignore_empty=True,
        extra="ignore",
        frozen=True,
    )

    # production turns on the startup check below; dev and tests run with fewer variables.
    binary_env: Literal["development", "production"] = "development"

    database_url: str
    token_encryption_key: EncryptionKey | None = None
    embed_api_key: SecretStr | None = None
    embed_model: str = "Qwen/Qwen3-Embedding-0.6B"
    embed_port: int = 8787
    # local loads the model in this process; remote sends file chunks to the embedding
    # service at EMBED_URL (bl serve-embed, or workers/modal_embed.py in production).
    embedder: Literal["local", "remote"] = "local"
    embed_url: str | None = None
    anthropic_api_key: SecretStr | None = None

    # Talk-throughs: ElevenLabs Scribe by default, or faster-whisper on this machine.
    transcriber: Literal["elevenlabs", "whisper"] = "elevenlabs"
    elevenlabs_api_key: SecretStr | None = None
    whisper_model: str = "small"
    # Optional: posters and video transcripts need it; without it videos still play.
    ffmpeg_path: str = "ffmpeg"

    dropbox_app_key: str | None = None
    dropbox_app_secret: SecretStr | None = None

    preview_store: Literal["r2", "local"] = "r2"
    preview_dir: Path = Path(".data/previews")
    r2_account_id: str | None = None
    r2_access_key_id: str | None = None
    r2_secret_access_key: SecretStr | None = None
    r2_bucket: str = "binary-labs-previews"


def load_settings(**overrides: object) -> Settings:
    return Settings(**overrides)  # type: ignore[arg-type]


class ConfigError(SystemExit):
    """Every missing or malformed variable at once, before the worker takes a job."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        lines = "\n".join(f"  - {p}" for p in problems)
        super().__init__(f"The worker's environment isn't ready:\n{lines}")


def _https(url: str | None) -> bool:
    return url is not None and urlparse(url).scheme == "https" and bool(urlparse(url).netloc)


def production_problems(s: Settings) -> list[str]:
    """What a production worker needs that dev can do without. Empty means ready."""
    problems = []
    if s.token_encryption_key is None:
        problems.append("TOKEN_ENCRYPTION_KEY: missing (the same value as the web app's)")
    if urlparse(s.database_url).scheme not in ("postgres", "postgresql"):
        problems.append("DATABASE_URL: not a postgresql:// URL")
    if s.embed_model == "hash-1024":
        problems.append("EMBED_MODEL: hash-1024 is the test embedder")
    match s.embedder:
        case "remote":
            if not _https(s.embed_url):
                problems.append("EMBED_URL: missing or not https (the embedding service's /embed)")
            if s.embed_api_key is None:
                problems.append("EMBED_API_KEY: missing (EMBEDDER=remote sends it to EMBED_URL)")
        case "local":
            if importlib.util.find_spec("sentence_transformers") is None:
                problems.append(
                    "EMBEDDER: local needs sentence-transformers, which this image leaves out;"
                    " set EMBEDDER=remote"
                )
    if s.preview_store != "r2":
        problems.append("PREVIEW_STORE: must be r2 (a local folder doesn't outlive the machine)")
    for name in ("r2_account_id", "r2_access_key_id", "r2_secret_access_key"):
        if getattr(s, name) is None:
            problems.append(f"{name.upper()}: missing")
    if s.dropbox_app_key is None or s.dropbox_app_secret is None:
        problems.append("DROPBOX_APP_KEY, DROPBOX_APP_SECRET: missing (tokens can't refresh)")
    if s.anthropic_api_key is None:
        problems.append("ANTHROPIC_API_KEY: missing (labels would come from rules alone)")
    if s.transcriber == "elevenlabs" and s.elevenlabs_api_key is None:
        problems.append("ELEVENLABS_API_KEY: missing (TRANSCRIBER=elevenlabs)")
    if shutil.which(s.ffmpeg_path) is None:
        problems.append(f"FFMPEG_PATH: {s.ffmpeg_path!r} isn't on this machine")
    return problems


def load_checked_settings(**overrides: object) -> Settings:
    """load_settings, but a bad environment stops the process with one list of what's wrong,
    and BINARY_ENV=production also checks everything a hosted worker needs."""
    try:
        settings = load_settings(**overrides)
    except ValidationError as e:
        raise ConfigError(
            [
                f"{'.'.join(str(p) for p in err['loc']).upper() or 'env'}: {err['msg']}"
                for err in e.errors()
            ]
        ) from None
    if settings.binary_env == "production" and (problems := production_problems(settings)):
        raise ConfigError(problems)
    return settings
