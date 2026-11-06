import base64

import pytest

from bl_worker.config import ConfigError, Settings, load_checked_settings, production_problems

KEY = base64.b64encode(bytes(range(32))).decode()

READY = {
    "binary_env": "production",
    "database_url": "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
    "token_encryption_key": KEY,
    "embedder": "remote",
    "embed_url": "https://lab--binary-embed.modal.run/embed",
    "embed_api_key": "k",
    "preview_store": "r2",
    "r2_account_id": "a",
    "r2_access_key_id": "b",
    "r2_secret_access_key": "c",
    "dropbox_app_key": "d",
    "dropbox_app_secret": "e",
    "anthropic_api_key": "f",
    "elevenlabs_api_key": "g",
    # Any program on PATH stands in for ffmpeg here.
    "ffmpeg_path": "sh",
}


def settings(**values: object) -> Settings:
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


def names(problems: list[str]) -> list[str]:
    return [p.split(":")[0] for p in problems]


def test_a_complete_production_environment_passes():
    assert production_problems(settings(**READY)) == []


def test_every_problem_is_listed_at_once():
    bare = settings(
        database_url="mysql://x",
        embedder="remote",
        preview_store="local",
        ffmpeg_path="no-such-ffmpeg",
    )
    assert names(production_problems(bare)) == [
        "TOKEN_ENCRYPTION_KEY",
        "DATABASE_URL",
        "EMBED_URL",
        "EMBED_API_KEY",
        "PREVIEW_STORE",
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "DROPBOX_APP_KEY, DROPBOX_APP_SECRET",
        "ANTHROPIC_API_KEY",
        "ELEVENLABS_API_KEY",
        "FFMPEG_PATH",
    ]


def test_malformed_values_are_named():
    plain_http = {**READY, "embed_url": "http://lab.modal.run/embed", "embed_model": "hash-1024"}
    assert names(production_problems(settings(**plain_http))) == ["EMBED_MODEL", "EMBED_URL"]


def test_the_local_embedder_needs_its_library(monkeypatch):
    monkeypatch.setattr("importlib.util.find_spec", lambda _name: None)
    assert names(production_problems(settings(**{**READY, "embedder": "local"}))) == ["EMBEDDER"]


def test_production_refuses_to_start_with_one_message(monkeypatch):
    for name, value in {**READY, "anthropic_api_key": "", "embed_api_key": ""}.items():
        monkeypatch.setenv(name.upper(), value)
    with pytest.raises(ConfigError) as e:
        load_checked_settings(_env_file=None)
    message = str(e.value)
    assert message.splitlines()[0] == "The worker's environment isn't ready:"
    assert names([line.strip(" -") for line in message.splitlines()[1:]]) == [
        "EMBED_API_KEY",
        "ANTHROPIC_API_KEY",
    ]


def test_a_bad_value_stops_any_environment(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/x")
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", base64.b64encode(b"short").decode())
    with pytest.raises(ConfigError, match="TOKEN_ENCRYPTION_KEY"):
        load_checked_settings(_env_file=None)


def test_a_missing_database_is_named(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(ConfigError, match="DATABASE_URL: Field required"):
        load_checked_settings(_env_file=None)


def test_dev_starts_with_only_a_database(monkeypatch):
    monkeypatch.delenv("BINARY_ENV", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/x")
    assert load_checked_settings(_env_file=None).embedder == "local"
