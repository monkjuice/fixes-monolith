from __future__ import annotations

from typing import Any

from pymongo.database import Database
from starlette.testclient import TestClient

from fixes_server.ids import new_id
from tests.conftest import MakeClient
from tests.helpers import Account, Device, assert_error, befriend, linked_user


def _request(client: TestClient, sender: Device, to: Account | str):  # type: ignore[no-untyped-def]
    to_id = to if isinstance(to, str) else to.id
    return client.post("/v1/friend-requests", json={"to_user_id": to_id}, headers=sender.headers)


def test_request_and_lists(client: TestClient) -> None:
    alice, alice_dev = linked_user(client)
    bob, bob_dev = linked_user(client)
    response = _request(client, alice_dev, bob)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "pending"
    request = body["friend_request"]
    assert set(request) == {"id", "from_user", "to_user", "created_at"}
    assert request["from_user"] == {"id": alice.id, "username": alice.username, "avatar_url": None}
    assert request["to_user"] == {"id": bob.id, "username": bob.username, "avatar_url": None}

    alice_lists = client.get("/v1/friend-requests", headers=alice_dev.headers).json()
    bob_lists = client.get("/v1/friend-requests", headers=bob_dev.headers).json()
    assert alice_lists == {"incoming": [], "outgoing": [request]}
    assert bob_lists == {"incoming": [request], "outgoing": []}
    assert client.get("/v1/friends", headers=bob_dev.headers).json() == {"friends": []}


def test_duplicate_request(client: TestClient) -> None:
    _, alice_dev = linked_user(client)
    bob, _ = linked_user(client)
    assert _request(client, alice_dev, bob).status_code == 201
    assert_error(_request(client, alice_dev, bob), 409, "request_exists")


def test_reciprocal_request_auto_accepts(client: TestClient, db: Database[dict[str, Any]]) -> None:
    alice, alice_dev = linked_user(client)
    bob, bob_dev = linked_user(client)
    assert _request(client, alice_dev, bob).status_code == 201
    response = _request(client, bob_dev, alice)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "status": "accepted",
        "friend": {"id": alice.id, "username": alice.username, "avatar_url": None},
    }
    assert db.friend_requests.count_documents({}) == 0
    assert [
        u["id"] for u in client.get("/v1/friends", headers=alice_dev.headers).json()["friends"]
    ] == [bob.id]
    assert [
        u["id"] for u in client.get("/v1/friends", headers=bob_dev.headers).json()["friends"]
    ] == [alice.id]
    assert_error(_request(client, alice_dev, bob), 409, "already_friends")


def test_only_recipient_can_accept(client: TestClient) -> None:
    alice, alice_dev = linked_user(client)
    bob, bob_dev = linked_user(client)
    _, carol_dev = linked_user(client)
    request_id = _request(client, alice_dev, bob).json()["friend_request"]["id"]
    for outsider in (alice_dev, carol_dev):
        response = client.post(f"/v1/friend-requests/{request_id}/accept", headers=outsider.headers)
        assert_error(response, 404, "not_found")
    response = client.post(f"/v1/friend-requests/{request_id}/accept", headers=bob_dev.headers)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "friend": {"id": alice.id, "username": alice.username, "avatar_url": None}
    }
    assert client.get("/v1/friend-requests", headers=bob_dev.headers).json() == {
        "incoming": [],
        "outgoing": [],
    }
    again = client.post(f"/v1/friend-requests/{request_id}/accept", headers=bob_dev.headers)
    assert_error(again, 404, "not_found")
    assert_error(
        client.post(f"/v1/friend-requests/{new_id()}/accept", headers=bob_dev.headers),
        404,
        "not_found",
    )


def test_decline_and_cancel(client: TestClient) -> None:
    _, alice_dev = linked_user(client)
    bob, bob_dev = linked_user(client)
    _, carol_dev = linked_user(client)

    declined = _request(client, alice_dev, bob).json()["friend_request"]["id"]
    assert_error(
        client.delete(f"/v1/friend-requests/{declined}", headers=carol_dev.headers),
        404,
        "not_found",
    )
    assert (
        client.delete(f"/v1/friend-requests/{declined}", headers=bob_dev.headers).status_code == 204
    )
    assert client.get("/v1/friend-requests", headers=alice_dev.headers).json()["outgoing"] == []

    cancelled = _request(client, alice_dev, bob).json()["friend_request"]["id"]
    assert (
        client.delete(f"/v1/friend-requests/{cancelled}", headers=alice_dev.headers).status_code
        == 204
    )
    assert client.get("/v1/friend-requests", headers=bob_dev.headers).json()["incoming"] == []
    assert_error(
        client.delete(f"/v1/friend-requests/{cancelled}", headers=alice_dev.headers),
        404,
        "not_found",
    )
    assert client.get("/v1/friends", headers=alice_dev.headers).json() == {"friends": []}


def test_self_unknown_and_invalid_targets(client: TestClient) -> None:
    alice, alice_dev = linked_user(client)
    assert_error(_request(client, alice_dev, alice), 400, "cannot_friend_self")
    assert_error(_request(client, alice_dev, new_id()), 404, "not_found")
    assert_error(_request(client, alice_dev, "bob"), 422, "validation_error")


def test_friends_ordered_and_unfriend(client: TestClient) -> None:
    me = linked_user(client, "me_" + new_id()[:6])
    friends = [linked_user(client, name) for name in ("zed_friend", "Amy_friend", "bob_friend")]
    for friend in friends:
        befriend(client, me, friend)
    listed = client.get("/v1/friends", headers=me[1].headers).json()["friends"]
    assert [u["username"] for u in listed] == ["Amy_friend", "bob_friend", "zed_friend"]

    zed = friends[0]
    assert client.delete(f"/v1/friends/{zed[0].id}", headers=me[1].headers).status_code == 204
    assert_error(client.delete(f"/v1/friends/{zed[0].id}", headers=me[1].headers), 404, "not_found")
    assert [
        u["username"] for u in client.get("/v1/friends", headers=zed[1].headers).json()["friends"]
    ] == []
    # Unfriended users can start over.
    assert _request(client, zed[1], me[0]).status_code == 201


def test_unfriend_unknown(client: TestClient) -> None:
    _, device = linked_user(client)
    stranger, _ = linked_user(client)
    assert_error(
        client.delete(f"/v1/friends/{stranger.id}", headers=device.headers), 404, "not_found"
    )


def test_friend_request_rate_limit(make_client: MakeClient) -> None:
    with make_client(rate_limit_friend_requests="1/86400") as client:
        _, device = linked_user(client)
        first, second = linked_user(client), linked_user(client)
        assert _request(client, device, first[0]).status_code == 201
        limited = _request(client, device, second[0])
        assert_error(limited, 429, "rate_limited")
        assert int(limited.headers["Retry-After"]) >= 1
