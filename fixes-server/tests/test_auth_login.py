from __future__ import annotations

import re
from typing import Any

import pytest
from argon2 import PasswordHasher, Type
from pymongo.database import Database
from starlette.testclient import TestClient

from fixes_server.ids import is_uuid4
from tests.conftest import MakeClient
from tests.helpers import (
    CLIENT_IP_HEADER,
    RecordingHooks,
    app_context,
    assert_error,
    b64,
    login,
    login_request,
    new_device_key,
    random_password,
    register,
)

ISO_MS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

# X25519 points of small order (and non-canonical encodings of them).
LOW_ORDER_POINTS = {
    "zero": bytes(32),
    "one": bytes([1]) + bytes(31),
    "order8_a": bytes.fromhex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
    "order8_b": bytes.fromhex("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157"),
    "p_minus_1": bytes.fromhex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    "p": bytes.fromhex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    "p_plus_1": bytes.fromhex("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
}


def test_login_ok(client: TestClient, hooks: RecordingHooks) -> None:
    account = register(client)
    _, public_key = new_device_key()
    # Login is case-insensitive on the username.
    response = login_request(
        client, account.username.upper(), account.password, public_key, name="  Pixel 9  "
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {
        "access_token",
        "refresh_token",
        "token_type",
        "expires_in",
        "user",
        "device",
    }
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 900
    assert body["user"] == {
        "id": account.id,
        "username": account.username,
        "avatar_url": None,
        "identity_key": None,
    }
    device = body["device"]
    assert set(device) == {
        "id",
        "name",
        "public_key",
        "certificate",
        "created_at",
        "last_seen_at",
        "current",
    }
    assert is_uuid4(device["id"])
    assert device["name"] == "Pixel 9"
    assert device["public_key"] == public_key
    assert device["certificate"] is None
    assert device["current"] is True
    assert ISO_MS.match(device["created_at"])
    assert ISO_MS.match(device["last_seen_at"])
    assert ("devices_changed", account.id, (device["id"],)) in hooks.events

    me = client.get("/v1/users/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200


def test_wrong_password_and_unknown_user_look_the_same(client: TestClient) -> None:
    account = register(client)
    _, key = new_device_key()
    wrong = login_request(client, account.username, random_password(), key)
    unknown = login_request(client, "nobody_here", random_password(), key)
    malformed = login_request(client, "not a username!", random_password(), key)
    for response in (wrong, unknown, malformed):
        assert_error(response, 401, "invalid_credentials")
    assert wrong.json() == unknown.json() == malformed.json()


@pytest.mark.parametrize("name", sorted(LOW_ORDER_POINTS))
def test_low_order_public_keys_rejected(client: TestClient, name: str) -> None:
    account = register(client)
    response = login_request(
        client, account.username, account.password, b64(LOW_ORDER_POINTS[name])
    )
    assert_error(response, 400, "invalid_public_key")


@pytest.mark.parametrize("length", [0, 31, 33, 48])
def test_wrong_length_public_keys_rejected(client: TestClient, length: int) -> None:
    account = register(client)
    response = login_request(client, account.username, account.password, b64(b"\x09" * length))
    assert_error(response, 400, "invalid_public_key")


@pytest.mark.parametrize(
    "public_key",
    [
        "not base64!",
        "AAAA",
        "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA",
        "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA-",
    ],
)
def test_malformed_base64_is_validation_error(client: TestClient, public_key: str) -> None:
    account = register(client)
    response = login_request(client, account.username, account.password, public_key)
    if public_key == "AAAA":
        # Valid base64, but 3 bytes: a key problem, not a format problem.
        assert_error(response, 400, "invalid_public_key")
    else:
        assert "device.public_key" in assert_error(response, 422, "validation_error")["fields"]


def test_bad_public_key_checked_without_valid_credentials(client: TestClient) -> None:
    response = login_request(client, "whoever", random_password(), b64(bytes(32)))
    assert_error(response, 400, "invalid_public_key")


def test_duplicate_device_key(client: TestClient) -> None:
    account = register(client)
    other = register(client)
    _, key = new_device_key()
    assert login_request(client, account.username, account.password, key).status_code == 200
    assert_error(
        login_request(client, account.username, account.password, key), 409, "device_key_in_use"
    )
    assert_error(
        login_request(client, other.username, other.password, key), 409, "device_key_in_use"
    )


def test_ten_device_cap(client: TestClient) -> None:
    account = register(client)
    devices = [login(client, account, name=f"Phone {i}") for i in range(10)]
    _, key = new_device_key()
    response = login_request(client, account.username, account.password, key)
    details = assert_error(response, 409, "too_many_devices")
    listed = details["devices"]
    assert len(listed) == 10
    assert {d["id"] for d in listed} == {d.id for d in devices}
    assert all(set(d) == {"id", "name", "last_seen_at"} for d in listed)
    assert all(ISO_MS.match(d["last_seen_at"]) for d in listed)

    # Signing one out frees a slot.
    assert (
        client.delete(f"/v1/devices/{devices[0].id}", headers=devices[1].headers).status_code == 204
    )
    assert login_request(client, account.username, account.password, key).status_code == 200


def test_login_failure_limit_per_username_and_ip(make_client: MakeClient) -> None:
    with make_client(
        rate_limit_login_failures_user_ip="3/900", rate_limit_login_failures_ip="100/3600"
    ) as client:
        account = register(client)
        for _ in range(3):
            _, key = new_device_key()
            assert_error(
                login_request(client, account.username, random_password(), key),
                401,
                "invalid_credentials",
            )
        _, key = new_device_key()
        # Exhausted: even the right password is refused before any hashing happens.
        limited = login_request(client, account.username.upper(), account.password, key)
        assert_error(limited, 429, "rate_limited")
        assert int(limited.headers["Retry-After"]) >= 1
        # Other usernames from this IP and this username from another IP are unaffected.
        other = register(client)
        assert login_request(client, other.username, other.password, key).status_code == 200
        _, key2 = new_device_key()
        elsewhere = login_request(
            client,
            account.username,
            account.password,
            key2,
            headers={CLIENT_IP_HEADER: "198.51.100.7"},
        )
        assert elsewhere.status_code == 200


def test_login_failure_limit_per_ip_across_usernames(make_client: MakeClient) -> None:
    with make_client(
        rate_limit_login_failures_user_ip="100/900", rate_limit_login_failures_ip="3/3600"
    ) as client:
        account = register(client)
        for username in ("ghost_one", "ghost_two", account.username):
            _, key = new_device_key()
            assert_error(
                login_request(client, username, random_password(), key), 401, "invalid_credentials"
            )
        _, key = new_device_key()
        assert_error(
            login_request(client, "ghost_three", random_password(), key), 429, "rate_limited"
        )
        assert_error(
            login_request(client, account.username, account.password, key), 429, "rate_limited"
        )


def test_successful_logins_do_not_count_as_failures(make_client: MakeClient) -> None:
    with make_client(rate_limit_login_failures_user_ip="2/900") as client:
        account = register(client)
        _, key = new_device_key()
        assert_error(
            login_request(client, account.username, random_password(), key),
            401,
            "invalid_credentials",
        )
        for _ in range(4):
            login(client, account)
        _, key = new_device_key()
        assert_error(
            login_request(client, account.username, random_password(), key),
            401,
            "invalid_credentials",
        )
        _, key = new_device_key()
        assert_error(
            login_request(client, account.username, random_password(), key), 429, "rate_limited"
        )


def test_successful_password_checks_are_limited_per_account(
    make_client: MakeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Correct passwords cost argon2 work and create devices, so they are limited too."""
    with make_client(rate_limit_login_success="3/3600") as client:
        account = register(client)
        for _ in range(3):
            device = login(client, account)
            assert client.post("/v1/auth/logout", headers=device.headers).status_code == 204

        passwords = app_context(client).passwords
        real_verify = passwords.verify
        verifications = 0

        async def counting_verify(*args: Any) -> bool:
            nonlocal verifications
            verifications += 1
            return await real_verify(*args)

        monkeypatch.setattr(passwords, "verify", counting_verify)
        _, key = new_device_key()
        limited = login_request(client, account.username, account.password, key)
        assert_error(limited, 429, "rate_limited")
        assert int(limited.headers["Retry-After"]) >= 1
        assert verifications == 0  # refused before any hashing
        # The limit is per account.
        other = register(client)
        login(client, other)


def test_failed_password_checks_do_not_use_the_success_limit(make_client: MakeClient) -> None:
    with make_client(rate_limit_login_success="1/3600") as client:
        account = register(client)
        for _ in range(3):
            _, key = new_device_key()
            assert_error(
                login_request(client, account.username, random_password(), key),
                401,
                "invalid_credentials",
            )
        device = login(client, account)
        _, key = new_device_key()
        assert_error(
            login_request(client, account.username, account.password, key), 429, "rate_limited"
        )
        # Re-authentication for a password change is a password check like a login.
        changed = client.post(
            "/v1/auth/password",
            json={"current_password": account.password, "new_password": random_password()},
            headers=device.headers,
        )
        assert_error(changed, 429, "rate_limited")


def test_ipv6_clients_are_limited_by_their_64(make_client: MakeClient) -> None:
    """One IPv6 subscriber holds a whole /64, so per-IP limits key IPv6 clients by it."""
    with make_client(rate_limit_login_failures_user_ip="2/900") as client:
        account = register(client)
        for address in ("2001:db8::1", "2001:db8::ffff:2"):
            _, key = new_device_key()
            response = login_request(
                client,
                account.username,
                random_password(),
                key,
                headers={CLIENT_IP_HEADER: address},
            )
            assert_error(response, 401, "invalid_credentials")
        _, key = new_device_key()
        same_64 = login_request(
            client,
            account.username,
            account.password,
            key,
            headers={CLIENT_IP_HEADER: "2001:db8::3"},
        )
        assert_error(same_64, 429, "rate_limited")
        other_64 = login_request(
            client,
            account.username,
            account.password,
            key,
            headers={CLIENT_IP_HEADER: "2001:db8:0:1::1"},
        )
        assert other_64.status_code == 200, other_64.text


def test_password_rehashed_when_parameters_change(
    client: TestClient, db: Database[dict[str, Any]]
) -> None:
    account = register(client)
    weak = PasswordHasher(time_cost=1, memory_cost=8192, parallelism=1, type=Type.ID)
    db.users.update_one(
        {"_id": account.id}, {"$set": {"password_hash": weak.hash(account.password)}}
    )
    login(client, account)
    stored = db.users.find_one({"_id": account.id})
    assert stored is not None
    assert stored["password_hash"].startswith("$argon2id$v=19$m=65536,t=3,p=1$")
    login(client, account)  # The upgraded hash still verifies.


@pytest.mark.parametrize("name", ["", "   ", "x" * 65])
def test_device_name_validation(client: TestClient, name: str) -> None:
    account = register(client)
    _, key = new_device_key()
    response = login_request(client, account.username, account.password, key, name=name)
    assert "device.name" in assert_error(response, 422, "validation_error")["fields"]
