"""Refresh-token rotation, reuse detection, the 60 s grace and sliding expiry (§5.3, §5.5)."""

from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from pymongo.database import Database
from starlette.testclient import TestClient

from tests.conftest import MakeClient
from tests.helpers import RecordingHooks, assert_error, login, register


def _refresh(client: TestClient, token: str) -> httpx.Response:
    return client.post("/v1/auth/refresh", json={"refresh_token": token})


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def test_rotation(client: TestClient, db: Database[dict[str, Any]]) -> None:
    account = register(client)
    device = login(client, account)
    stored = db.refresh_tokens.find_one({"_id": _hash(device.refresh_token)})
    assert stored is not None
    assert stored["device_id"] == device.id
    # Only the hash is stored.
    assert device.refresh_token not in str(list(db.refresh_tokens.find()))

    response = _refresh(client, device.refresh_token)
    assert response.status_code == 200, response.text
    tokens = response.json()
    assert set(tokens) == {"access_token", "refresh_token", "token_type", "expires_in"}
    assert tokens["token_type"] == "bearer"
    assert tokens["expires_in"] == 900
    assert tokens["refresh_token"] != device.refresh_token

    old = db.refresh_tokens.find_one({"_id": _hash(device.refresh_token)})
    assert old is not None
    assert old["used_at"] is not None
    assert old["replaced_by"] == _hash(tokens["refresh_token"])
    new = db.refresh_tokens.find_one({"_id": _hash(tokens["refresh_token"])})
    assert new is not None
    assert new["used_at"] is None
    # Sliding expiry: a fresh 30 days from now.
    remaining = new["expires_at"] - datetime.now(UTC)
    assert timedelta(days=29, hours=23) < remaining <= timedelta(days=30)

    me = client.get("/v1/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert me.status_code == 200
    # The rotated token works again.
    assert _refresh(client, tokens["refresh_token"]).status_code == 200


def test_refresh_updates_last_seen(client: TestClient, db: Database[dict[str, Any]]) -> None:
    account = register(client)
    device = login(client, account)
    old = datetime.now(UTC) - timedelta(days=3)
    db.devices.update_one({"_id": device.id}, {"$set": {"last_seen_at": old}})
    assert _refresh(client, device.refresh_token).status_code == 200
    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    assert stored["last_seen_at"] > old + timedelta(days=2)


def test_retry_within_grace_gets_fresh_pair(
    client: TestClient, db: Database[dict[str, Any]]
) -> None:
    account = register(client)
    device = login(client, account)
    first = _refresh(client, device.refresh_token).json()
    # The client lost that response and retries with the old token.
    retry = _refresh(client, device.refresh_token)
    assert retry.status_code == 200, retry.text
    second = retry.json()
    assert second["refresh_token"] not in {first["refresh_token"], device.refresh_token}
    # The successor the client never saw is now spent; the retry's token is live.
    lost = db.refresh_tokens.find_one({"_id": _hash(first["refresh_token"])})
    assert lost is not None
    assert lost["used_at"] is not None
    assert _refresh(client, second["refresh_token"]).status_code == 200


def test_reuse_after_grace_revokes_device(
    client: TestClient, db: Database[dict[str, Any]], hooks: RecordingHooks
) -> None:
    account = register(client)
    device = login(client, account)
    current = _refresh(client, device.refresh_token).json()
    db.refresh_tokens.update_one(
        {"_id": _hash(device.refresh_token)},
        {"$set": {"used_at": datetime.now(UTC) - timedelta(seconds=61)}},
    )
    hooks.events.clear()
    assert_error(_refresh(client, device.refresh_token), 401, "invalid_refresh_token")

    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    assert stored["revoked_at"] is not None
    assert db.refresh_tokens.count_documents({"device_id": device.id}) == 0
    assert hooks.names() == [
        "delete_pending_envelopes",
        "close_device_sockets",
        "devices_changed",
    ]
    headers = {"Authorization": f"Bearer {current['access_token']}"}
    assert_error(client.get("/v1/users/me", headers=headers), 401, "device_revoked")
    assert_error(_refresh(client, current["refresh_token"]), 401, "invalid_refresh_token")


def test_reuse_when_successor_already_used_revokes(
    client: TestClient, db: Database[dict[str, Any]]
) -> None:
    account = register(client)
    device = login(client, account)
    second = _refresh(client, device.refresh_token).json()
    assert _refresh(client, second["refresh_token"]).status_code == 200
    # Within 60 s, but the successor was already rotated: this is theft, not a retry.
    assert_error(_refresh(client, device.refresh_token), 401, "invalid_refresh_token")
    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    assert stored["revoked_at"] is not None


def test_expired_token(client: TestClient, db: Database[dict[str, Any]]) -> None:
    account = register(client)
    device = login(client, account)
    db.refresh_tokens.update_one(
        {"_id": _hash(device.refresh_token)},
        {"$set": {"expires_at": datetime.now(UTC) - timedelta(seconds=1)}},
    )
    assert_error(_refresh(client, device.refresh_token), 401, "invalid_refresh_token")
    # Expiry is not reuse: the device stays signed in.
    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    assert stored["revoked_at"] is None
    assert client.get("/v1/users/me", headers=device.headers).status_code == 200


def test_unknown_and_malformed_tokens(client: TestClient) -> None:
    assert_error(_refresh(client, "A" * 43), 401, "invalid_refresh_token")
    assert_error(client.post("/v1/auth/refresh", json={}), 422, "validation_error")
    assert_error(_refresh(client, ""), 422, "validation_error")


@pytest.mark.parametrize(
    "token_json",
    [
        '"' + "é" * 43 + '"',  # non-ASCII
        '"' + "\\u00e9" * 10 + '"',
        '"' + "+/" * 21 + 'A"',  # ASCII, but not base64url
    ],
    ids=["non_ascii", "short_non_ascii", "not_base64url"],
)
def test_malformed_refresh_tokens_are_simply_unknown(
    client: TestClient, caplog: pytest.LogCaptureFixture, token_json: str
) -> None:
    response = client.post(
        "/v1/auth/refresh",
        content=('{"refresh_token": ' + token_json + "}").encode(),
        headers={"Content-Type": "application/json"},
    )
    assert_error(response, 401, "invalid_refresh_token")
    assert not [record for record in caplog.records if record.levelno >= logging.ERROR]


def test_revoked_device(client: TestClient, db: Database[dict[str, Any]]) -> None:
    account = register(client)
    device = login(client, account)
    # A revocation interrupted after its first step (§5.4): the token still exists.
    db.devices.update_one({"_id": device.id}, {"$set": {"revoked_at": datetime.now(UTC)}})
    assert_error(_refresh(client, device.refresh_token), 401, "device_revoked")

    other = login(client, account)
    assert client.post("/v1/auth/logout", headers=other.headers).status_code == 204
    # A completed revocation deleted the token, so it is simply unknown now.
    assert_error(_refresh(client, other.refresh_token), 401, "invalid_refresh_token")


def test_refresh_finishes_an_interrupted_revocation(
    client: TestClient, db: Database[dict[str, Any]], hooks: RecordingHooks
) -> None:
    account = register(client)
    device = login(client, account)
    revoked_at = datetime.now(UTC).replace(microsecond=0)
    db.devices.update_one({"_id": device.id}, {"$set": {"revoked_at": revoked_at}})
    hooks.events.clear()

    assert_error(_refresh(client, device.refresh_token), 401, "device_revoked")
    # The leftover token proved the revocation stopped after step 1; the rest ran now.
    assert db.refresh_tokens.count_documents({"device_id": device.id}) == 0
    assert hooks.names() == ["delete_pending_envelopes", "close_device_sockets", "devices_changed"]
    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    assert stored["revoked_at"] == revoked_at
    assert_error(_refresh(client, device.refresh_token), 401, "invalid_refresh_token")


def test_refresh_rate_limit_per_device(make_client: MakeClient) -> None:
    with make_client(rate_limit_refresh="2/3600") as client:
        account = register(client)
        device = login(client, account)
        token = device.refresh_token
        for _ in range(2):
            response = _refresh(client, token)
            assert response.status_code == 200
            token = response.json()["refresh_token"]
        limited = _refresh(client, token)
        assert_error(limited, 429, "rate_limited")
        assert int(limited.headers["Retry-After"]) >= 1
        # Another device of the same user has its own budget.
        other = login(client, account)
        assert _refresh(client, other.refresh_token).status_code == 200
