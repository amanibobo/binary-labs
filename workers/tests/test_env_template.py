"""workers/.env.production.example and fly.toml's [env] together have to set every setting a
production worker reads, or a deploy goes out with a gap the template never mentioned."""

import re
import tomllib
from pathlib import Path

from bl_worker.config import Settings

WORKERS = Path(__file__).resolve().parents[1]

# Settings whose defaults are right in production, and why.
DEFAULTED = {
    "EMBED_MODEL",  # Qwen3-Embedding-0.6B, the model modal_embed.py serves
    "EMBED_PORT",  # serve-embed only
    "WHISPER_MODEL",  # TRANSCRIBER=whisper only
    "FFMPEG_PATH",  # the image puts ffmpeg on PATH
    "PREVIEW_DIR",  # the local store only
}


def template_names() -> list[str]:
    text = (WORKERS / ".env.production.example").read_text()
    return re.findall(r"^([A-Z][A-Z0-9_]*)=", text, flags=re.M)


def fly_env() -> set[str]:
    return set(tomllib.loads((WORKERS / "fly.toml").read_text())["env"])


def test_template_and_fly_toml_set_every_setting_once():
    secrets = template_names()
    assert len(secrets) == len(set(secrets))
    assert not set(secrets) & fly_env(), "a setting is both a secret and in fly.toml [env]"
    fields = {name.upper() for name in Settings.model_fields}
    assert set(secrets) | fly_env() | DEFAULTED == fields


def test_fly_toml_turns_on_the_production_check():
    env = tomllib.loads((WORKERS / "fly.toml").read_text())["env"]
    assert env["BINARY_ENV"] == "production"
    assert env["EMBEDDER"] == "remote"
    assert env["PREVIEW_STORE"] == "r2"
