from __future__ import annotations

from typing import Any

import pytest
from pymongo.errors import ServerSelectionTimeoutError
from starlette.testclient import TestClient

from tests.helpers import app_context, assert_error


def test_healthz_ok(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


class _DownAdmin:
    async def command(self, *_: Any, **__: Any) -> None:
        raise ServerSelectionTimeoutError("no servers")


class _DownMongo:
    """Wraps the real client but fails pings; close() still reaches the real client."""

    def __init__(self, real: Any) -> None:
        self._real = real
        self.admin = _DownAdmin()

    async def close(self) -> None:
        await self._real.close()


def test_healthz_503_when_database_down(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = app_context(client)
    monkeypatch.setattr(ctx, "mongo", _DownMongo(ctx.mongo))
    assert_error(client.get("/healthz"), 503, "service_unavailable")


def test_media_404_uses_error_format(client: TestClient) -> None:
    assert_error(client.get("/media/avatars/" + "0" * 32 + ".jpg"), 404, "not_found")


def test_openapi_schema_lists_every_endpoint(client: TestClient) -> None:
    response = client.get("/openapi.json")
    assert response.status_code == 200
    paths = response.json()["paths"]
    expected = {
        "/healthz": {"get"},
        "/v1/auth/register": {"post"},
        "/v1/auth/login": {"post"},
        "/v1/auth/refresh": {"post"},
        "/v1/auth/logout": {"post"},
        "/v1/auth/password": {"post"},
        "/v1/auth/reset-identity": {"post"},
        "/v1/users/me": {"get"},
        "/v1/users/me/identity": {"put"},
        "/v1/users/me/avatar": {"put"},
        "/v1/users": {"get"},
        "/v1/users/{user_id}": {"get"},
        "/v1/users/{user_id}/devices": {"get"},
        "/v1/users/{user_id}/devices/{device_id}": {"get"},
        "/v1/devices": {"get"},
        "/v1/devices/{device_id}": {"delete"},
        "/v1/devices/{device_id}/certificate": {"put"},
        "/v1/friends": {"get"},
        "/v1/friends/{user_id}": {"delete"},
        "/v1/friend-requests": {"get", "post"},
        "/v1/friend-requests/{request_id}/accept": {"post"},
        "/v1/friend-requests/{request_id}": {"delete"},
        "/v1/envelopes": {"get", "post"},
        "/v1/envelopes/ack": {"post"},
    }
    assert {path: set(ops) for path, ops in paths.items()} == expected
    # Binary fields are documented as base64 strings, not raw bytes.
    schemas = response.json()["components"]["schemas"]
    outgoing = schemas["OutgoingEnvelope"]["properties"]
    for field in ("nonce", "ciphertext"):
        assert (outgoing[field]["type"], outgoing[field]["format"]) == ("string", "byte")
    assert "sender_user_id" not in outgoing
