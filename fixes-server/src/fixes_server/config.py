"""Runtime configuration, read from ``FIXES_*`` environment variables (never from dotenv files)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    SecretStr,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

ENV_PREFIX = "FIXES_"
JWT_SECRET_MIN_LENGTH = 32

_RATE_LIMIT_RE = re.compile(r"\s*(\d+)\s*/\s*(\d+(?:\.\d+)?)\s*")
_DB_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,63}")


class RateLimit(BaseModel):
    """A token bucket: ``capacity`` requests, refilled evenly over ``period_seconds``."""

    model_config = ConfigDict(frozen=True)

    capacity: int = Field(ge=1)
    period_seconds: float = Field(gt=0)


def _parse_rate_limit(value: Any) -> Any:
    # Operators write limits as "<count>/<seconds>" (e.g. "5/3600"), like the spec table.
    if isinstance(value, str):
        match = _RATE_LIMIT_RE.fullmatch(value)
        if match is None:
            raise ValueError("expected '<count>/<seconds>', for example '5/3600'")
        return {"capacity": int(match[1]), "period_seconds": float(match[2])}
    return value


def _split_csv(value: Any) -> Any:
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


RateLimitSetting = Annotated[RateLimit, NoDecode, BeforeValidator(_parse_rate_limit)]
CsvList = Annotated[list[str], NoDecode, BeforeValidator(_split_csv)]


def _rate(capacity: int, period_seconds: float) -> RateLimit:
    return RateLimit(capacity=capacity, period_seconds=period_seconds)


def _normalize_base_url(value: str) -> str:
    if not re.fullmatch(r"https?://[^\s/?#]+(/[^\s?#]*)?", value):
        raise ValueError("must be an absolute http(s) URL without query or fragment")
    return value.rstrip("/")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix=ENV_PREFIX,
        case_sensitive=False,
        extra="ignore",
        # Configuration comes from the process environment only; no dotenv/secrets files.
        env_file=None,
        # Docker Compose passes unset optional variables as "", which must mean "default".
        env_ignore_empty=True,
    )

    jwt_secret: SecretStr
    mongodb_uri: SecretStr = SecretStr("mongodb://127.0.0.1:27017")
    mongodb_db: str = "fixes"
    public_base_url: str = "http://localhost:8000"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    storage_backend: Literal["local", "s3"] = "local"
    storage_local_dir: Path = Path("data/media")
    s3_bucket: str | None = None
    s3_endpoint_url: str | None = None
    s3_region: str | None = None
    s3_public_base_url: str | None = None

    envelope_ttl_days: int = Field(default=30, ge=1, le=365)
    device_idle_days: int = Field(default=30, ge=1, le=3650)
    cors_origins: CsvList = Field(default_factory=list)

    rate_limit_register: RateLimitSetting = _rate(5, 3600)
    rate_limit_login_failures_user_ip: RateLimitSetting = _rate(10, 900)
    rate_limit_login_failures_ip: RateLimitSetting = _rate(50, 3600)
    # Not in the §5.6 table: correct passwords still cost an argon2 verification in the shared
    # worker pool and logins create device documents, so they are bounded per account too.
    rate_limit_login_success: RateLimitSetting = _rate(30, 3600)
    rate_limit_refresh: RateLimitSetting = _rate(30, 3600)
    rate_limit_envelopes: RateLimitSetting = _rate(600, 60)
    rate_limit_user_lookup: RateLimitSetting = _rate(60, 60)
    rate_limit_friend_requests: RateLimitSetting = _rate(50, 86400)
    rate_limit_avatar: RateLimitSetting = _rate(10, 3600)
    rate_limit_ws_connect: RateLimitSetting = _rate(20, 60)
    ws_max_unauthenticated_per_ip: int = Field(default=20, ge=1)
    # §6 fixes 10 s; configurable so tests (and slow links, if ever needed) can change it.
    ws_auth_timeout_seconds: float = Field(default=10.0, gt=0, le=120)

    @field_validator("jwt_secret")
    @classmethod
    def _check_jwt_secret(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < JWT_SECRET_MIN_LENGTH:
            raise ValueError(f"must be at least {JWT_SECRET_MIN_LENGTH} characters long")
        return value

    @field_validator("mongodb_db")
    @classmethod
    def _check_db_name(cls, value: str) -> str:
        if not _DB_NAME_RE.fullmatch(value):
            raise ValueError("must be 1-63 characters of [A-Za-z0-9_-]")
        return value

    @field_validator("public_base_url", "s3_public_base_url", "s3_endpoint_url")
    @classmethod
    def _check_urls(cls, value: str | None) -> str | None:
        return None if value is None else _normalize_base_url(value)

    @model_validator(mode="after")
    def _check_storage(self) -> Self:
        if self.storage_backend == "s3":
            missing = [
                f"{ENV_PREFIX}{name.upper()}"
                for name in ("s3_bucket", "s3_public_base_url")
                if not getattr(self, name)
            ]
            if missing:
                raise ValueError(f"the s3 storage backend requires {', '.join(missing)}")
        return self


class ConfigError(RuntimeError):
    """Raised when the environment does not describe a runnable server."""


def load_settings(**overrides: Any) -> Settings:
    """Load settings, turning validation failures into a message that never echoes values.

    pydantic's default error text includes the offending input, which could be a secret
    (for example a too-short JWT secret or a MongoDB URI with credentials).
    """
    try:
        return Settings(**overrides)
    except ValidationError as exc:
        problems = []
        for error in exc.errors(include_input=False, include_url=False, include_context=False):
            field = ".".join(str(part) for part in error["loc"])
            name = f"{ENV_PREFIX}{field.upper()}" if field else "settings"
            problems.append(f"{name}: {error['msg']}")
        raise ConfigError("invalid configuration: " + "; ".join(problems)) from None
