"""Identity creation, device certificates and the caller's own device list (§5.3)."""

from __future__ import annotations

from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pymongo.database import Database
from starlette.testclient import TestClient

from fixes_server.ids import new_id
from tests.helpers import (
    RecordingHooks,
    assert_error,
    b64,
    certify,
    linked_user,
    login,
    make_certificate,
    register,
    set_identity,
)


def test_set_identity_certifies_current_device(client: TestClient, hooks: RecordingHooks) -> None:
    account = register(client)
    device = login(client, account)
    hooks.events.clear()
    response = set_identity(client, account, device)
    me = response.json()["user"]
    assert me["identity_key"] == account.identity_key
    assert ("devices_changed", account.id, ()) in hooks.events

    devices = client.get("/v1/devices", headers=device.headers).json()["devices"]
    assert devices[0]["certificate"] is not None
    assert (
        client.get("/v1/users/me", headers=device.headers).json()["identity_key"]
        == account.identity_key
    )


def test_identity_can_only_be_set_once(client: TestClient) -> None:
    account, device = linked_user(client)
    other = login(client, account)
    identity = Ed25519PrivateKey.generate()
    response = client.put(
        "/v1/users/me/identity",
        json={
            "identity_key": b64(identity.public_key().public_bytes_raw()),
            "device_certificate": make_certificate(
                identity, account.id, other.id, other.public_key
            ),
        },
        headers=other.headers,
    )
    assert_error(response, 409, "identity_exists")
    assert (
        client.get("/v1/users/me", headers=device.headers).json()["identity_key"]
        == account.identity_key
    )


def test_set_identity_rejects_bad_certificate_and_key(client: TestClient) -> None:
    account = register(client)
    device = login(client, account)
    identity = Ed25519PrivateKey.generate()
    impostor = Ed25519PrivateKey.generate()
    public = b64(identity.public_key().public_bytes_raw())

    signed_by_other_key = make_certificate(impostor, account.id, device.id, device.public_key)
    response = client.put(
        "/v1/users/me/identity",
        json={"identity_key": public, "device_certificate": signed_by_other_key},
        headers=device.headers,
    )
    assert_error(response, 400, "invalid_certificate")

    wrong_statement = make_certificate(identity, account.id, new_id(), device.public_key)
    response = client.put(
        "/v1/users/me/identity",
        json={"identity_key": public, "device_certificate": wrong_statement},
        headers=device.headers,
    )
    assert_error(response, 400, "invalid_certificate")

    response = client.put(
        "/v1/users/me/identity",
        json={"identity_key": public, "device_certificate": b64(b"\x00" * 63)},
        headers=device.headers,
    )
    assert_error(response, 400, "invalid_certificate")

    response = client.put(
        "/v1/users/me/identity",
        json={
            "identity_key": b64(b"\x05" * 16),
            "device_certificate": make_certificate(
                identity, account.id, device.id, device.public_key
            ),
        },
        headers=device.headers,
    )
    assert_error(response, 400, "invalid_public_key")
    assert client.get("/v1/users/me", headers=device.headers).json()["identity_key"] is None


def test_certify_new_device(client: TestClient, hooks: RecordingHooks) -> None:
    account, linked = linked_user(client)
    new = login(client, account, name="Tablet")
    hooks.events.clear()
    response = certify(client, account, linked, new)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == new.id
    assert body["name"] == "Tablet"
    assert body["current"] is False
    assert body["certificate"] == make_certificate(
        account.identity, account.id, new.id, new.public_key
    )  # type: ignore[arg-type]
    assert hooks.events == [("devices_changed", account.id, ())]
    # A device can also certify itself (re-login on a phone that still holds the identity).
    again = login(client, account)
    assert certify(client, account, again, again).json()["current"] is True


def test_certificate_must_verify(client: TestClient) -> None:
    account, linked = linked_user(client)
    new = login(client, account)
    forged = make_certificate(Ed25519PrivateKey.generate(), account.id, new.id, new.public_key)
    response = client.put(
        f"/v1/devices/{new.id}/certificate", json={"certificate": forged}, headers=linked.headers
    )
    assert_error(response, 400, "invalid_certificate")
    other_device_cert = make_certificate(account.identity, account.id, new.id, linked.public_key)  # type: ignore[arg-type]
    response = client.put(
        f"/v1/devices/{new.id}/certificate",
        json={"certificate": other_device_cert},
        headers=linked.headers,
    )
    assert_error(response, 400, "invalid_certificate")
    response = client.put(
        f"/v1/devices/{new.id}/certificate", json={"certificate": "%%%"}, headers=linked.headers
    )
    assert_error(response, 422, "validation_error")


def test_certificate_for_foreign_revoked_or_unknown_device(client: TestClient) -> None:
    account, linked = linked_user(client)
    stranger, stranger_device = linked_user(client)
    # Another user's device, even with a certificate valid under *their* identity.
    valid_for_them = make_certificate(
        stranger.identity,
        stranger.id,
        stranger_device.id,
        stranger_device.public_key,  # type: ignore[arg-type]
    )
    response = client.put(
        f"/v1/devices/{stranger_device.id}/certificate",
        json={"certificate": valid_for_them},
        headers=linked.headers,
    )
    assert_error(response, 404, "not_found")

    gone = login(client, account)
    assert client.delete(f"/v1/devices/{gone.id}", headers=linked.headers).status_code == 204
    assert_error(certify(client, account, linked, gone), 404, "not_found")

    response = client.put(
        f"/v1/devices/{new_id()}/certificate",
        json={"certificate": b64(bytes(64))},
        headers=linked.headers,
    )
    assert_error(response, 404, "not_found")


def test_certificate_needs_an_identity(client: TestClient) -> None:
    account = register(client)
    first = login(client, account)
    second = login(client, account)
    response = client.put(
        f"/v1/devices/{second.id}/certificate",
        json={"certificate": b64(bytes(64))},
        headers=first.headers,
    )
    assert_error(response, 400, "invalid_certificate")


def test_device_list(client: TestClient) -> None:
    account, first = linked_user(client)
    second = login(client, account, name="Laptop")
    third = login(client, account, name="Old phone")
    assert client.post("/v1/auth/logout", headers=third.headers).status_code == 204

    response = client.get("/v1/devices", headers=second.headers)
    assert response.status_code == 200
    devices = response.json()["devices"]
    assert [d["id"] for d in devices] == [first.id, second.id]
    assert [d["current"] for d in devices] == [False, True]
    assert devices[0]["certificate"] is not None
    assert devices[1]["certificate"] is None
    assert devices[1]["name"] == "Laptop"
    assert devices[1]["public_key"] == second.public_key


def test_revoke_own_device(client: TestClient, hooks: RecordingHooks) -> None:
    account, first = linked_user(client)
    second = login(client, account)
    hooks.events.clear()
    assert client.delete(f"/v1/devices/{second.id}", headers=first.headers).status_code == 204
    assert hooks.events == [
        ("delete_pending_envelopes", (second.id,)),
        ("close_device_sockets", (second.id,)),
        ("devices_changed", account.id, (second.id,)),
    ]
    assert_error(client.get("/v1/users/me", headers=second.headers), 401, "device_revoked")
    ids = [d["id"] for d in client.get("/v1/devices", headers=first.headers).json()["devices"]]
    assert ids == [first.id]
    # Idempotent for one's own device.
    assert client.delete(f"/v1/devices/{second.id}", headers=first.headers).status_code == 204


def test_cannot_revoke_other_users_device(client: TestClient, db: Database[dict[str, Any]]) -> None:
    _, mine = linked_user(client)
    _, theirs = linked_user(client)
    assert_error(client.delete(f"/v1/devices/{theirs.id}", headers=mine.headers), 404, "not_found")
    assert_error(client.delete(f"/v1/devices/{new_id()}", headers=mine.headers), 404, "not_found")
    assert_error(client.delete("/v1/devices/xyz", headers=mine.headers), 422, "validation_error")
    stored = db.devices.find_one({"_id": theirs.id})
    assert stored is not None
    assert stored["revoked_at"] is None
    assert client.get("/v1/users/me", headers=theirs.headers).status_code == 200


def test_device_documents_are_never_deleted(
    client: TestClient, db: Database[dict[str, Any]]
) -> None:
    account = register(client)
    device = login(client, account)
    assert client.post("/v1/auth/logout", headers=device.headers).status_code == 204
    assert db.devices.count_documents({"_id": device.id}) == 1
