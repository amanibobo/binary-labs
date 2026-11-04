from __future__ import annotations

import base64
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BeforeValidator, SecretStr
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

    database_url: str
    token_encryption_key: EncryptionKey | None = None
    embed_api_key: SecretStr | None = None
    embed_model: str = "Qwen/Qwen3-Embedding-0.6B"
    embed_port: int = 8787
    anthropic_api_key: SecretStr | None = None

    # Talk-throughs: ElevenLabs Scribe by default, or faster-whisper on this machine.
    transcriber: Literal["elevenlabs", "whisper"] = "elevenlabs"
    elevenlabs_api_key: SecretStr | None = None
    whisper_model: str = "small"

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
