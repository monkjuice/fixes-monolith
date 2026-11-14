"""Shared fixtures. Every test gets its own MongoDB database, dropped afterwards."""

from __future__ import annotations

import os
import secrets
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import Any

import pytest
from pymongo import MongoClient
from pymongo.database import Database
from pymongo.errors import PyMongoError
from starlette.testclient import TestClient

from fixes_server.config import Settings
from fixes_server.main import create_app
from tests.helpers import ClientIpOverride, RecordingHooks

DEFAULT_TEST_MONGODB_URI = "mongodb://127.0.0.1:27099"
TEST_DB_PREFIX = "fixes_test_"
# Limits high enough never to trigger by accident; rate-limit tests lower the one they test.
UNLIMITED = "1000000/60"
RATE_LIMIT_FIELDS = (
    "rate_limit_register",
    "rate_limit_login_failures_user_ip",
    "rate_limit_login_failures_ip",
    "rate_limit_login_success",
    "rate_limit_refresh",
    "rate_limit_envelopes",
    "rate_limit_user_lookup",
    "rate_limit_friend_requests",
    "rate_limit_avatar",
    "rate_limit_ws_connect",
)

MakeSettings = Callable[..., Settings]
MakeClient = Callable[..., AbstractContextManager[TestClient]]


@pytest.fixture(scope="session")
def mongo_uri() -> str:
    return os.environ.get("FIXES_TEST_MONGODB_URI", DEFAULT_TEST_MONGODB_URI)


@pytest.fixture(scope="session")
def mongo_client(mongo_uri: str) -> Iterator[MongoClient[dict[str, Any]]]:
    client: MongoClient[dict[str, Any]] = MongoClient(
        mongo_uri, serverSelectionTimeoutMS=3000, tz_aware=True
    )
    try:
        client.admin.command("ping")
    except PyMongoError as exc:
        client.close()
        pytest.fail(
            f"MongoDB is not reachable at {mongo_uri} ({type(exc).__name__}). Start a MongoDB "
            "server there or set FIXES_TEST_MONGODB_URI to one; the tests need a real database.",
            pytrace=False,
        )
    yield client
    client.close()


@pytest.fixture
def make_settings(
    mongo_uri: str, mongo_client: MongoClient[dict[str, Any]], tmp_path: Path
) -> Iterator[MakeSettings]:
    created: list[str] = []

    def factory(**overrides: Any) -> Settings:
        name = f"{TEST_DB_PREFIX}{uuid.uuid4().hex}"
        created.append(name)
        values: dict[str, Any] = {
            "jwt_secret": secrets.token_urlsafe(48),
            "mongodb_uri": mongo_uri,
            "mongodb_db": name,
            "public_base_url": "http://testserver",
            "storage_backend": "local",
            "storage_local_dir": tmp_path / name / "media",
            "cors_origins": [],
            **dict.fromkeys(RATE_LIMIT_FIELDS, UNLIMITED),
        }
        values.update(overrides)
        return Settings(**values)

    yield factory
    for name in created:
        # Only databases this fixture created (unique random names) are ever dropped.
        mongo_client.drop_database(name)


@pytest.fixture
def settings(make_settings: MakeSettings) -> Settings:
    return make_settings()


@pytest.fixture
def hooks() -> RecordingHooks:
    return RecordingHooks()


@pytest.fixture
def make_client(make_settings: MakeSettings, hooks: RecordingHooks) -> MakeClient:
    """Context manager factory for a client on fresh settings, e.g. with tighter limits."""

    @contextmanager
    def factory(
        settings: Settings | None = None, *, raise_server_exceptions: bool = True, **overrides: Any
    ) -> Iterator[TestClient]:
        app = create_app(settings or make_settings(**overrides), hooks=hooks)
        with TestClient(
            ClientIpOverride(app), raise_server_exceptions=raise_server_exceptions
        ) as client:
            yield client

    return factory


@pytest.fixture
def client(settings: Settings, make_client: MakeClient) -> Iterator[TestClient]:
    with make_client(settings) as test_client:
        yield test_client


@pytest.fixture
def db(mongo_client: MongoClient[dict[str, Any]], settings: Settings) -> Database[dict[str, Any]]:
    """Direct access to the test database, for arranging states the API cannot produce."""
    return mongo_client[settings.mongodb_db]
