"""Logout, password change, identity reset and ``last_seen_at`` bookkeeping."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from argon2 import PasswordHasher, Type
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pymongo.database import Database
from starlette.testclient import TestClient

from fixes_server.deps import authenticate_access_token
from fixes_server.routers import auth as auth_router
from fixes_server.services import accounts
from tests.conftest import MakeClient
from tests.helpers import (
    RecordingHooks,
    app_context,
    assert_error,
    b64,
    login,
    login_request,
    make_certificate,
    new_device_key,
    pause_first_password_check,
    random_password,
    register,
    set_identity,
)


def test_logout_revokes_current_device(
    client: TestClient, db: Database[dict[str, Any]], hooks: RecordingHooks
) -> None:
    account = register(client)
    device = login(client, account)
    other = login(client, account)
    hooks.events.clear()

    assert client.post("/v1/auth/logout", headers=device.headers).status_code == 204
    assert_error(client.get("/v1/users/me", headers=device.headers), 401, "device_revoked")
    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    assert stored["revoked_at"] is not None
    assert db.refresh_tokens.count_documents({"device_id": device.id}) == 0
    # §5.4 order, with the remaining sockets notified about the revoked device.
    assert hooks.events == [
        ("delete_pending_envelopes", (device.id,)),
        ("close_device_sockets", (device.id,)),
        ("devices_changed", account.id, (device.id,)),
    ]
    assert client.get("/v1/users/me", headers=other.headers).status_code == 200
    assert_error(client.post("/v1/auth/logout"), 401, "unauthorized")


def test_password_change_revokes_other_devices(client: TestClient) -> None:
    account = register(client)
    current = login(client, account)
    others = [login(client, account) for _ in range(2)]
    new_password = random_password()

    response = client.post(
        "/v1/auth/password",
        json={"current_password": account.password, "new_password": new_password},
        headers=current.headers,
    )
    assert response.status_code == 204, response.text
    assert client.get("/v1/users/me", headers=current.headers).status_code == 200
    for other in others:
        assert_error(client.get("/v1/users/me", headers=other.headers), 401, "device_revoked")
    devices = client.get("/v1/devices", headers=current.headers).json()["devices"]
    assert [d["id"] for d in devices] == [current.id]

    _, key = new_device_key()
    assert_error(
        login_request(client, account.username, account.password, key), 401, "invalid_credentials"
    )
    account.password = new_password
    login(client, account)


def test_password_change_rejects_wrong_password_and_weak_new_one(client: TestClient) -> None:
    account = register(client)
    current = login(client, account)
    other = login(client, account)
    wrong = client.post(
        "/v1/auth/password",
        json={"current_password": random_password(), "new_password": random_password()},
        headers=current.headers,
    )
    assert_error(wrong, 401, "invalid_credentials")
    weak = client.post(
        "/v1/auth/password",
        json={"current_password": account.password, "new_password": "short"},
        headers=current.headers,
    )
    assert "new_password" in assert_error(weak, 422, "validation_error")["fields"]
    # Nothing was revoked.
    assert client.get("/v1/users/me", headers=other.headers).status_code == 200


def test_password_change_is_limited_like_login(make_client: MakeClient) -> None:
    with make_client(rate_limit_login_failures_user_ip="2/900") as client:
        account = register(client)
        device = login(client, account)
        body = {"current_password": random_password(), "new_password": random_password()}
        for _ in range(2):
            assert_error(
                client.post("/v1/auth/password", json=body, headers=device.headers),
                401,
                "invalid_credentials",
            )
        assert_error(
            client.post("/v1/auth/password", json=body, headers=device.headers), 429, "rate_limited"
        )


def _change_password(client: TestClient, device_headers: dict[str, str], old: str, new: str) -> Any:
    return client.post(
        "/v1/auth/password",
        json={"current_password": old, "new_password": new},
        headers=device_headers,
    )


def _active_device_ids(db: Database[dict[str, Any]], user_id: str) -> list[str]:
    return [d["_id"] for d in db.devices.find({"user_id": user_id, "revoked_at": None})]


def test_login_racing_a_password_change_keeps_no_device(
    client: TestClient, db: Database[dict[str, Any]]
) -> None:
    """A login that verified the old password just before a password change and stores its
    device just after it must not survive "revokes all other devices" (§5.3)."""
    account = register(client)
    victim = login(client, account)
    _, attacker_key = new_device_key()
    with ThreadPoolExecutor(1) as pool, pause_first_password_check(client) as paused:
        attempt = pool.submit(
            login_request, client, account.username, account.password, attacker_key
        )
        assert paused.reached.wait(10)
        changed = _change_password(client, victim.headers, account.password, random_password())
        assert changed.status_code == 204, changed.text
        paused.release.set()
        assert_error(attempt.result(30), 401, "invalid_credentials")
    assert _active_device_ids(db, account.id) == [victim.id]
    assert client.get("/v1/users/me", headers=victim.headers).status_code == 200


def test_login_checked_just_before_a_password_change_is_revoked_by_it(
    client: TestClient, db: Database[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other interleaving: the login re-checks the password before the change writes the
    new hash, so the change must still find and revoke the login's new device."""
    account = register(client)
    victim = login(client, account)
    new_password = random_password()
    ctx = app_context(client)
    real_check = auth_router.password_unchanged

    async def check_then_change(*args: Any) -> bool:
        unchanged = await real_check(*args)
        principal = await authenticate_access_token(ctx, victim.access_token)
        await accounts.change_password(
            ctx, principal.user, victim.id, account.password, new_password, "203.0.113.1"
        )
        return unchanged

    monkeypatch.setattr(auth_router, "password_unchanged", check_then_change)
    _, attacker_key = new_device_key()
    response = login_request(client, account.username, account.password, attacker_key)
    assert response.status_code == 200, response.text
    token = {"Authorization": f"Bearer {response.json()['access_token']}"}
    assert_error(client.get("/v1/users/me", headers=token), 401, "device_revoked")
    assert _active_device_ids(db, account.id) == [victim.id]


def test_login_rehash_never_overwrites_a_newer_password(
    client: TestClient, db: Database[dict[str, Any]]
) -> None:
    """Upgrading an old-parameter hash on login must not write the old password back over a
    password change that landed while the login was verifying it."""
    account = register(client)
    victim = login(client, account)
    weak = PasswordHasher(time_cost=1, memory_cost=8192, parallelism=1, type=Type.ID)
    db.users.update_one(
        {"_id": account.id}, {"$set": {"password_hash": weak.hash(account.password)}}
    )
    old_password, new_password = account.password, random_password()
    _, attacker_key = new_device_key()
    with ThreadPoolExecutor(1) as pool, pause_first_password_check(client) as paused:
        attempt = pool.submit(login_request, client, account.username, old_password, attacker_key)
        assert paused.reached.wait(10)
        changed = _change_password(client, victim.headers, old_password, new_password)
        assert changed.status_code == 204, changed.text
        paused.release.set()
        assert_error(attempt.result(30), 401, "invalid_credentials")
    _, key = new_device_key()
    assert_error(
        login_request(client, account.username, old_password, key), 401, "invalid_credentials"
    )
    account.password = new_password
    login(client, account)


def test_interrupted_password_change_can_be_retried(
    make_client: MakeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Other devices are signed out before the new hash is written: a failure in between
    leaves the old password valid (the same form succeeds on retry) instead of a changed
    password with the devices to lock out still signed in."""
    with make_client(raise_server_exceptions=False) as client:
        account = register(client)
        current = login(client, account)
        other = login(client, account)
        users: Any = app_context(client).db.users

        async def failing_write(*args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("the database went away")

        monkeypatch.setattr(users, "update_one", failing_write)
        new_password = random_password()
        failed = _change_password(client, current.headers, account.password, new_password)
        assert_error(failed, 500, "internal_error")
        monkeypatch.undo()

        assert_error(client.get("/v1/users/me", headers=other.headers), 401, "device_revoked")
        retried = _change_password(client, current.headers, account.password, new_password)
        assert retried.status_code == 204, retried.text
        account.password = new_password
        login(client, account)


def test_password_change_from_a_device_revoked_meanwhile_is_refused(
    client: TestClient, db: Database[dict[str, Any]]
) -> None:
    account = register(client)
    owner = login(client, account)
    intruder = login(client, account)
    with ThreadPoolExecutor(1) as pool, pause_first_password_check(client) as paused:
        attempt = pool.submit(
            _change_password, client, intruder.headers, account.password, random_password()
        )
        assert paused.reached.wait(10)
        # The owner signs the intruder out while its password change is being checked.
        response = client.delete(f"/v1/devices/{intruder.id}", headers=owner.headers)
        assert response.status_code == 204
        paused.release.set()
        assert_error(attempt.result(30), 401, "device_revoked")
    assert _active_device_ids(db, account.id) == [owner.id]
    login(client, account)  # The password did not change.


def _reset_body(
    account_id: str, device_id: str, public_key: str, password: str
) -> tuple[Ed25519PrivateKey, dict[str, str]]:
    identity = Ed25519PrivateKey.generate()
    return identity, {
        "password": password,
        "identity_key": b64(identity.public_key().public_bytes_raw()),
        "device_certificate": make_certificate(identity, account_id, device_id, public_key),
    }


def test_reset_identity(
    client: TestClient, db: Database[dict[str, Any]], hooks: RecordingHooks
) -> None:
    account = register(client)
    lost = login(client, account)
    set_identity(client, account, lost)
    old_identity = account.identity_key
    fresh = login(client, account)
    hooks.events.clear()

    _, body = _reset_body(account.id, fresh.id, fresh.public_key, account.password)
    response = client.post("/v1/auth/reset-identity", json=body, headers=fresh.headers)
    assert response.status_code == 200, response.text
    me = response.json()["user"]
    assert me["identity_key"] == body["identity_key"] != old_identity
    assert set(me) == {"id", "username", "avatar_url", "identity_key"}

    assert_error(client.get("/v1/users/me", headers=lost.headers), 401, "device_revoked")
    devices = client.get("/v1/devices", headers=fresh.headers).json()["devices"]
    assert [(d["id"], d["certificate"]) for d in devices] == [
        (fresh.id, body["device_certificate"])
    ]
    # The revoked device keeps its old certificate for verifying its past envelopes.
    stored = db.devices.find_one({"_id": lost.id})
    assert stored is not None
    assert stored["certificate"] is not None
    assert hooks.names() == [
        "delete_pending_envelopes",
        "close_device_sockets",
        "devices_changed",
    ]


def test_reset_identity_failures_change_nothing(client: TestClient) -> None:
    account = register(client)
    linked = login(client, account)
    set_identity(client, account, linked)
    fresh = login(client, account)

    _, body = _reset_body(account.id, fresh.id, fresh.public_key, random_password())
    assert_error(
        client.post("/v1/auth/reset-identity", json=body, headers=fresh.headers),
        401,
        "invalid_credentials",
    )
    # Certificate for another device's key.
    _, body = _reset_body(account.id, fresh.id, linked.public_key, account.password)
    assert_error(
        client.post("/v1/auth/reset-identity", json=body, headers=fresh.headers),
        400,
        "invalid_certificate",
    )
    _, body = _reset_body(account.id, fresh.id, fresh.public_key, account.password)
    body["identity_key"] = b64(b"\x01" * 31)
    assert_error(
        client.post("/v1/auth/reset-identity", json=body, headers=fresh.headers),
        400,
        "invalid_public_key",
    )
    me = client.get("/v1/users/me", headers=linked.headers)
    assert me.status_code == 200
    assert me.json()["identity_key"] == account.identity_key


def test_identity_reset_racing_a_password_change_is_refused(
    client: TestClient, db: Database[dict[str, Any]]
) -> None:
    """A reset that verified the old password before a password change signed its device out
    must not then sign out the account owner and replace the identity key."""
    account = register(client)
    owner = login(client, account)
    set_identity(client, account, owner)
    intruder = login(client, account)
    _, body = _reset_body(account.id, intruder.id, intruder.public_key, account.password)
    with ThreadPoolExecutor(1) as pool, pause_first_password_check(client) as paused:
        attempt = pool.submit(
            client.post, "/v1/auth/reset-identity", json=body, headers=intruder.headers
        )
        assert paused.reached.wait(10)
        changed = _change_password(client, owner.headers, account.password, random_password())
        assert changed.status_code == 204, changed.text
        paused.release.set()
        assert_error(attempt.result(30), 401, "device_revoked")
    me = client.get("/v1/users/me", headers=owner.headers)
    assert me.status_code == 200, me.text
    assert me.json()["identity_key"] == account.identity_key
    assert _active_device_ids(db, account.id) == [owner.id]


def test_last_seen_updated_at_most_hourly(client: TestClient, db: Database[dict[str, Any]]) -> None:
    account = register(client)
    device = login(client, account)

    recent = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=30)
    db.devices.update_one({"_id": device.id}, {"$set": {"last_seen_at": recent}})
    assert client.get("/v1/users/me", headers=device.headers).status_code == 200
    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    assert stored["last_seen_at"] == recent

    stale = datetime.now(UTC) - timedelta(hours=2)
    db.devices.update_one({"_id": device.id}, {"$set": {"last_seen_at": stale}})
    assert client.get("/v1/users/me", headers=device.headers).status_code == 200
    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    assert stored["last_seen_at"] > datetime.now(UTC) - timedelta(minutes=1)
