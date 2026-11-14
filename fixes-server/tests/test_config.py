from __future__ import annotations

import os
import secrets
from pathlib import Path

import pytest

from fixes_server.config import ConfigError, RateLimit, Settings, load_settings
from fixes_server.main import app_from_env


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in list(os.environ):
        if name.upper().startswith("FIXES_"):
            monkeypatch.delenv(name)
    return monkeypatch


def test_missing_jwt_secret_refuses_to_start(clean_env: pytest.MonkeyPatch) -> None:
    with pytest.raises(ConfigError, match="FIXES_JWT_SECRET"):
        load_settings()
    with pytest.raises(ConfigError, match="FIXES_JWT_SECRET"):
        app_from_env()


def test_short_jwt_secret_is_rejected_without_echoing_it(clean_env: pytest.MonkeyPatch) -> None:
    short = secrets.token_hex(15)  # 30 characters
    clean_env.setenv("FIXES_JWT_SECRET", short)
    with pytest.raises(ConfigError) as excinfo:
        load_settings()
    assert "FIXES_JWT_SECRET" in str(excinfo.value)
    assert short not in str(excinfo.value)
    assert excinfo.value.__cause__ is None
    assert excinfo.value.__suppress_context__


def test_settings_from_environment(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("FIXES_JWT_SECRET", secrets.token_urlsafe(40))
    clean_env.setenv("FIXES_PUBLIC_BASE_URL", "https://chat.example.org/")
    clean_env.setenv("FIXES_RATE_LIMIT_REGISTER", "7/60")
    clean_env.setenv("FIXES_CORS_ORIGINS", "https://a.example, https://b.example")
    clean_env.setenv("FIXES_ENVELOPE_TTL_DAYS", "12")
    settings = load_settings()
    assert settings.public_base_url == "https://chat.example.org"
    assert settings.rate_limit_register == RateLimit(capacity=7, period_seconds=60)
    assert settings.cors_origins == ["https://a.example", "https://b.example"]
    assert settings.envelope_ttl_days == 12
    # Defaults follow the protocol tables.
    assert settings.rate_limit_login_failures_user_ip == RateLimit(capacity=10, period_seconds=900)
    assert settings.rate_limit_login_failures_ip == RateLimit(capacity=50, period_seconds=3600)
    assert settings.device_idle_days == 30
    assert settings.storage_backend == "local"


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("FIXES_RATE_LIMIT_REFRESH", "thirty"),
        ("FIXES_RATE_LIMIT_REFRESH", "0/60"),
        ("FIXES_PUBLIC_BASE_URL", "chat.example.org"),
        ("FIXES_MONGODB_DB", "bad name"),
        ("FIXES_STORAGE_BACKEND", "ftp"),
        ("FIXES_ENVELOPE_TTL_DAYS", "0"),
    ],
)
def test_invalid_values_fail_fast(clean_env: pytest.MonkeyPatch, name: str, value: str) -> None:
    clean_env.setenv("FIXES_JWT_SECRET", secrets.token_urlsafe(40))
    clean_env.setenv(name, value)
    with pytest.raises(ConfigError, match=name):
        load_settings()


def test_s3_backend_requires_bucket_and_public_url(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("FIXES_JWT_SECRET", secrets.token_urlsafe(40))
    clean_env.setenv("FIXES_STORAGE_BACKEND", "s3")
    with pytest.raises(ConfigError, match="FIXES_S3_BUCKET"):
        load_settings()
    clean_env.setenv("FIXES_S3_BUCKET", "avatars")
    clean_env.setenv("FIXES_S3_PUBLIC_BASE_URL", "https://cdn.example.org")
    assert load_settings().s3_bucket == "avatars"


def test_empty_values_mean_default(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("FIXES_JWT_SECRET", secrets.token_urlsafe(40))
    for name in (
        "FIXES_S3_ENDPOINT_URL",
        "FIXES_S3_BUCKET",
        "FIXES_CORS_ORIGINS",
        "FIXES_RATE_LIMIT_AVATAR",
    ):
        clean_env.setenv(name, "")
    settings = load_settings()
    assert settings.s3_endpoint_url is None
    assert settings.s3_bucket is None
    assert settings.cors_origins == []
    assert settings.rate_limit_avatar == RateLimit(capacity=10, period_seconds=3600)
    clean_env.setenv("FIXES_JWT_SECRET", "")
    with pytest.raises(ConfigError, match="FIXES_JWT_SECRET"):
        load_settings()


def test_mongodb_uri_is_secret(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("FIXES_JWT_SECRET", secrets.token_urlsafe(40))
    password = secrets.token_hex(8)
    clean_env.setenv("FIXES_MONGODB_URI", f"mongodb://fixes:{password}@db:27017")
    settings = load_settings()
    assert password not in repr(settings)
    assert password not in str(settings.model_dump())


def test_every_setting_is_documented() -> None:
    root = Path(__file__).resolve().parents[1]
    readme = (root / "README.md").read_text(encoding="utf-8")
    example = (root / "example.env").read_text(encoding="utf-8")
    compose = (root / "docker-compose.yml").read_text(encoding="utf-8")
    # The compose file pins the avatar directory to its volume, so example.env omits it.
    not_in_example = {"FIXES_STORAGE_LOCAL_DIR"}
    for name in Settings.model_fields:
        variable = f"FIXES_{name.upper()}"
        assert f"| `{variable}` |" in readme, variable
        assert f"{variable}:" in compose, variable
        if variable not in not_in_example:
            assert f"\n{variable}=" in example, variable
