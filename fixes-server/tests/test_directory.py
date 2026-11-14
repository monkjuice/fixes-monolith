"""Device directory access: self and friends only; linked devices listed; any device by id."""

from __future__ import annotations

import re

from starlette.testclient import TestClient

from fixes_server.ids import new_id
from tests.helpers import assert_error, befriend, certify, linked_user, login

ISO_MS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def test_self_sees_linked_devices_only(client: TestClient) -> None:
    account, linked = linked_user(client)
    unlinked = login(client, account)
    response = client.get(f"/v1/users/{account.id}/devices", headers=unlinked.headers)
    assert response.status_code == 200
    body = response.json()
    assert body["identity_key"] == account.identity_key
    assert body["devices"] == [
        {
            "id": linked.id,
            "public_key": linked.public_key,
            "certificate": client.get("/v1/devices", headers=linked.headers).json()["devices"][0][
                "certificate"
            ],
        }
    ]
    assert certify(client, account, linked, unlinked).status_code == 200
    ids = [
        d["id"]
        for d in client.get(f"/v1/users/{account.id}/devices", headers=linked.headers).json()[
            "devices"
        ]
    ]
    assert ids == [linked.id, unlinked.id]


def test_friend_access_and_revoked_devices(client: TestClient) -> None:
    alice = linked_user(client)
    bob = linked_user(client)
    befriend(client, alice, bob)
    bob_account, bob_device = bob
    spare = login(client, bob_account)
    assert certify(client, bob_account, bob_device, spare).status_code == 200

    listing = client.get(f"/v1/users/{bob_account.id}/devices", headers=alice[1].headers)
    assert listing.status_code == 200
    assert [d["id"] for d in listing.json()["devices"]] == [bob_device.id, spare.id]

    assert client.delete(f"/v1/devices/{spare.id}", headers=bob_device.headers).status_code == 204
    listing = client.get(f"/v1/users/{bob_account.id}/devices", headers=alice[1].headers)
    assert [d["id"] for d in listing.json()["devices"]] == [bob_device.id]

    # Revoked devices remain resolvable by id, with their revocation time.
    info = client.get(f"/v1/users/{bob_account.id}/devices/{spare.id}", headers=alice[1].headers)
    assert info.status_code == 200
    body = info.json()
    assert set(body) == {"id", "user_id", "public_key", "certificate", "revoked_at"}
    assert body["id"] == spare.id
    assert body["user_id"] == bob_account.id
    assert body["public_key"] == spare.public_key
    assert body["certificate"] is not None
    assert ISO_MS.match(body["revoked_at"])

    active = client.get(
        f"/v1/users/{bob_account.id}/devices/{bob_device.id}", headers=alice[1].headers
    )
    assert active.json()["revoked_at"] is None


def test_unlinked_device_info_has_null_certificate(client: TestClient) -> None:
    account, linked = linked_user(client)
    unlinked = login(client, account)
    info = client.get(f"/v1/users/{account.id}/devices/{unlinked.id}", headers=linked.headers)
    assert info.status_code == 200
    assert info.json()["certificate"] is None


def test_non_friends_are_forbidden(client: TestClient) -> None:
    _, mine = linked_user(client)
    stranger, stranger_device = linked_user(client)
    assert_error(
        client.get(f"/v1/users/{stranger.id}/devices", headers=mine.headers), 403, "not_friends"
    )
    assert_error(
        client.get(f"/v1/users/{stranger.id}/devices/{stranger_device.id}", headers=mine.headers),
        403,
        "not_friends",
    )
    # A pending request is not a friendship.
    assert (
        client.post(
            "/v1/friend-requests", json={"to_user_id": stranger.id}, headers=mine.headers
        ).status_code
        == 201
    )
    assert_error(
        client.get(f"/v1/users/{stranger.id}/devices", headers=mine.headers), 403, "not_friends"
    )


def test_unknown_user_and_device(client: TestClient) -> None:
    alice = linked_user(client)
    bob = linked_user(client)
    befriend(client, alice, bob)
    headers = alice[1].headers
    assert_error(client.get(f"/v1/users/{new_id()}/devices", headers=headers), 404, "not_found")
    assert_error(
        client.get(f"/v1/users/{new_id()}/devices/{bob[1].id}", headers=headers), 404, "not_found"
    )
    assert_error(
        client.get(f"/v1/users/{bob[0].id}/devices/{new_id()}", headers=headers), 404, "not_found"
    )
    # A device must be looked up under its own user.
    assert_error(
        client.get(f"/v1/users/{bob[0].id}/devices/{alice[1].id}", headers=headers),
        404,
        "not_found",
    )


def test_identity_key_null_before_identity(client: TestClient) -> None:
    from tests.helpers import register

    account = register(client)
    device = login(client, account)
    body = client.get(f"/v1/users/{account.id}/devices", headers=device.headers).json()
    assert body == {"identity_key": None, "devices": []}
