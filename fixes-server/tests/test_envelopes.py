"""The envelope relay (protocol §5.3 Envelopes, §11)."""

from __future__ import annotations

import json
import logging
import re
import secrets
import threading
from concurrent.futures import Future
from datetime import UTC, datetime, timedelta
from typing import Any

import anyio
import pytest
from bson import ObjectId
from pymongo import MongoClient
from pymongo.database import Database
from starlette.testclient import TestClient
from starlette.types import Message

from fixes_server import middleware
from fixes_server.ids import new_id
from fixes_server.middleware import MAX_PAGES_PER_DEVICE, PAGE_CHUNK_BYTES
from fixes_server.services import envelopes as envelopes_service
from tests.conftest import MakeClient
from tests.helpers import (
    Account,
    Device,
    app_context,
    assert_error,
    b64,
    befriend,
    certify,
    fetch,
    linked_user,
    login,
    outgoing,
    send,
    send_ok,
)

ISO_MS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
OBJECT_ID = re.compile(r"^[0-9a-f]{24}$")
User = tuple[Account, Device]


@pytest.fixture
def alice(client: TestClient) -> User:
    return linked_user(client)


@pytest.fixture
def bob(client: TestClient, alice: User) -> User:
    user = linked_user(client)
    befriend(client, alice, user)
    return user


def second_linked_device(client: TestClient, user: User, name: str = "Tablet") -> Device:
    device = login(client, user[0], name=name)
    assert certify(client, user[0], user[1], device).status_code == 200
    return device


def test_send_to_friend_and_fetch(
    client: TestClient, db: Database[dict[str, Any]], alice: User, bob: User
) -> None:
    bob_tablet = second_linked_device(client, bob)
    envelopes = [outgoing(bob[1].id), outgoing(bob_tablet.id)]
    result = send_ok(client, alice[1], envelopes, complete_for=[bob[0].id, alice[0].id])

    assert set(result) == {"ids", "created_at", "dropped_device_ids"}
    assert all(OBJECT_ID.match(envelope_id) for envelope_id in result["ids"])
    assert ISO_MS.match(result["created_at"])
    assert result["dropped_device_ids"] == []

    body = fetch(client, bob[1])
    assert body["gap"] is False
    assert body["envelopes"] == [
        {
            "id": result["ids"][0],
            "sender_user_id": alice[0].id,
            "sender_device_id": alice[1].id,
            "recipient_device_id": bob[1].id,
            "nonce": envelopes[0]["nonce"],
            "ciphertext": envelopes[0]["ciphertext"],
            "created_at": result["created_at"],
        }
    ]
    assert [e["id"] for e in fetch(client, bob_tablet)["envelopes"]] == [result["ids"][1]]
    # The sender sees nothing of its own batch.
    assert fetch(client, alice[1])["envelopes"] == []

    stored = db.envelopes.find_one({"_id": ObjectId(result["ids"][0])})
    assert stored is not None
    assert stored["recipient_user_id"] == bob[0].id
    assert stored["size"] == 272
    # Binary data is stored as BSON binary, and the TTL follows FIXES_ENVELOPE_TTL_DAYS.
    assert isinstance(stored["ciphertext"], bytes)
    assert stored["expires_at"] - stored["created_at"] == timedelta(days=30)


def test_one_created_at_per_batch(client: TestClient, alice: User, bob: User) -> None:
    result = send_ok(client, alice[1], [outgoing(bob[1].id) for _ in range(5)])
    envelopes = fetch(client, bob[1])["envelopes"]
    assert len(envelopes) == 5
    assert {e["created_at"] for e in envelopes} == {result["created_at"]}


def test_envelope_ttl_setting(
    make_client: MakeClient, mongo_client: MongoClient[dict[str, Any]]
) -> None:
    with make_client(envelope_ttl_days=3) as client:
        alice = linked_user(client)
        bob = linked_user(client)
        befriend(client, alice, bob)
        result = send_ok(client, alice[1], [outgoing(bob[1].id)])
        database = mongo_client[app_context(client).settings.mongodb_db]
        stored = database.envelopes.find_one({"_id": ObjectId(result["ids"][0])})
        assert stored is not None
        assert stored["expires_at"] - stored["created_at"] == timedelta(days=3)


def test_send_to_own_devices_including_unlinked(client: TestClient, alice: User) -> None:
    new_device = login(client, alice[0], name="New phone")  # not linked yet
    # A linked device sends the link envelope to the new, unlinked device (§9).
    result = send_ok(client, alice[1], [outgoing(new_device.id)])
    assert [e["id"] for e in fetch(client, new_device)["envelopes"]] == result["ids"]
    # The unlinked device may write to its own account's devices too.
    reply = send_ok(client, new_device, [outgoing(alice[1].id)])
    assert [e["id"] for e in fetch(client, alice[1])["envelopes"]] == reply["ids"]


def test_non_friends_are_refused(client: TestClient, alice: User) -> None:
    stranger = linked_user(client)
    assert_error(send(client, alice[1], [outgoing(stranger[1].id)]), 403, "not_friends")
    # Even a revoked device of a stranger answers not_friends, never stale_devices.
    other = login(client, stranger[0])
    assert client.post("/v1/auth/logout", headers=other.headers).status_code == 204
    assert_error(send(client, alice[1], [outgoing(other.id)]), 403, "not_friends")
    # complete_for_user_ids would leak a stranger's device ids through missing_device_ids.
    response = send(client, alice[1], [], complete_for=[stranger[0].id])
    assert_error(response, 422, "validation_error")  # an empty batch is invalid anyway
    response = send(client, alice[1], [outgoing(alice[1].id)], complete_for=[stranger[0].id])
    details = assert_error(response, 403, "not_friends")
    assert details == {}
    # Unknown users cannot be friends either.
    response = send(client, alice[1], [outgoing(alice[1].id)], complete_for=[new_id()])
    assert_error(response, 403, "not_friends")


def test_unlinked_sender_cannot_message_other_users(
    client: TestClient, alice: User, bob: User
) -> None:
    unlinked = login(client, alice[0])
    response = send(client, unlinked, [outgoing(bob[1].id)])
    assert_error(response, 403, "device_not_linked")


def test_stale_recipients(
    client: TestClient, db: Database[dict[str, Any]], alice: User, bob: User
) -> None:
    unknown = new_id()
    bob_unlinked = login(client, bob[0])
    bob_revoked = second_linked_device(client, bob)
    assert client.delete(f"/v1/devices/{bob_revoked.id}", headers=bob[1].headers).status_code == 204
    alice_revoked = login(client, alice[0])
    assert client.post("/v1/auth/logout", headers=alice_revoked.headers).status_code == 204

    batch = [
        outgoing(bob[1].id),  # valid, but the batch is all-or-nothing
        outgoing(unknown),
        outgoing(bob_unlinked.id),
        outgoing(bob_revoked.id),
        outgoing(alice_revoked.id),
        outgoing(unknown),
    ]
    details = assert_error(send(client, alice[1], batch), 409, "stale_devices")
    assert details == {
        "stale_device_ids": [unknown, bob_unlinked.id, bob_revoked.id, alice_revoked.id],
        "missing_device_ids": [],
    }
    assert db.envelopes.count_documents({}) == 0


def test_completeness(client: TestClient, alice: User, bob: User) -> None:
    bob_tablet = second_linked_device(client, bob)
    login(client, bob[0])  # unlinked devices are never required
    alice_tablet = second_linked_device(client, alice)
    complete = [bob[0].id, alice[0].id]

    response = send(client, alice[1], [outgoing(bob[1].id)], complete_for=complete)
    details = assert_error(response, 409, "stale_devices")
    assert details == {
        "stale_device_ids": [],
        # The sending device itself is never required.
        "missing_device_ids": sorted([bob_tablet.id, alice_tablet.id]),
    }

    # Stale and missing devices are reported together, so one refresh fixes both.
    unknown = new_id()
    response = send(
        client, alice[1], [outgoing(bob[1].id), outgoing(unknown)], complete_for=complete
    )
    details = assert_error(response, 409, "stale_devices")
    assert details["stale_device_ids"] == [unknown]
    assert details["missing_device_ids"] == sorted([bob_tablet.id, alice_tablet.id])

    full = [outgoing(bob[1].id), outgoing(bob_tablet.id), outgoing(alice_tablet.id)]
    result = send_ok(client, alice[1], full, complete_for=complete)
    assert None not in result["ids"]
    # Duplicate user ids are harmless.
    send_ok(client, alice[1], full, complete_for=[bob[0].id, bob[0].id])


@pytest.mark.parametrize(
    ("envelope_patch", "field"),
    [
        ({"nonce": b64(bytes(23))}, "envelopes.0.nonce"),
        ({"nonce": b64(bytes(25))}, "envelopes.0.nonce"),
        ({"nonce": "not base64!"}, "envelopes.0.nonce"),
        ({"nonce": 42}, "envelopes.0.nonce"),
        ({"ciphertext": b64(bytes(15))}, "envelopes.0.ciphertext"),
        ({"ciphertext": "QQ"}, "envelopes.0.ciphertext"),
        ({"recipient_device_id": "not-a-uuid"}, "envelopes.0.recipient_device_id"),
        ({"sender_user_id": "00000000-0000-4000-8000-000000000000"}, "envelopes.0.sender_user_id"),
    ],
)
def test_envelope_validation(
    client: TestClient, alice: User, bob: User, envelope_patch: dict[str, Any], field: str
) -> None:
    envelope = {**outgoing(bob[1].id), **envelope_patch}
    details = assert_error(send(client, alice[1], [envelope]), 422, "validation_error")
    assert field in details["fields"]


def test_batch_validation(client: TestClient, alice: User, bob: User) -> None:
    assert_error(send(client, alice[1], []), 422, "validation_error")
    too_many = [outgoing(bob[1].id, size=16) for _ in range(101)]
    assert_error(send(client, alice[1], too_many), 422, "validation_error")
    three_users = [new_id() for _ in range(3)]
    response = send(client, alice[1], [outgoing(bob[1].id)], complete_for=three_users)
    assert_error(response, 422, "validation_error")
    # Sender fields are not part of the body: spoofing attempts are rejected outright.
    response = client.post(
        "/v1/envelopes",
        json={"envelopes": [outgoing(bob[1].id)], "sender_device_id": bob[1].id},
        headers=alice[1].headers,
    )
    assert_error(response, 422, "validation_error")
    assert_error(client.post("/v1/envelopes", json={"envelopes": []}), 401, "unauthorized")
    send_ok(client, alice[1], [outgoing(bob[1].id, size=16) for _ in range(100)])


def test_sender_always_comes_from_the_token(client: TestClient, alice: User, bob: User) -> None:
    send_ok(client, alice[1], [outgoing(bob[1].id)])
    [envelope] = fetch(client, bob[1])["envelopes"]
    assert (envelope["sender_user_id"], envelope["sender_device_id"]) == (alice[0].id, alice[1].id)


def test_ciphertext_size_limit(client: TestClient, alice: User, bob: User) -> None:
    largest = outgoing(bob[1].id, size=65_536)
    send_ok(client, alice[1], [largest])
    response = send(client, alice[1], [outgoing(bob[1].id), outgoing(bob[1].id, size=65_537)])
    assert_error(response, 413, "payload_too_large")
    assert len(fetch(client, bob[1])["envelopes"]) == 1


def test_large_batches_fit_the_body_limit(client: TestClient, alice: User) -> None:
    # 100 maximal ciphertexts are about 8.4 MiB of base64, under the 9 MiB route limit (§5.7).
    own = login(client, alice[0])
    batch = [outgoing(own.id, size=65_536) for _ in range(100)]
    result = send_ok(client, alice[1], batch)
    assert None not in result["ids"]


def test_fetch_order_limit_and_expiry(
    client: TestClient, db: Database[dict[str, Any]], alice: User, bob: User
) -> None:
    ids: list[str] = []
    for size in (1, 3, 1):
        ids += send_ok(client, alice[1], [outgoing(bob[1].id) for _ in range(size)])["ids"]
    assert ids == sorted(ids)  # ids increase monotonically

    assert [e["id"] for e in fetch(client, bob[1])["envelopes"]] == ids
    assert [e["id"] for e in fetch(client, bob[1], limit=2)["envelopes"]] == ids[:2]
    assert len(fetch(client, bob[1], limit=500)["envelopes"]) == 5
    for limit in (0, 501, "x"):
        response = client.get("/v1/envelopes", params={"limit": limit}, headers=bob[1].headers)
        assert_error(response, 422, "validation_error")

    # An expired envelope the TTL monitor has not removed yet is never handed out.
    past = datetime.now(UTC) - timedelta(seconds=1)
    db.envelopes.update_one({"_id": ObjectId(ids[0])}, {"$set": {"expires_at": past}})
    assert [e["id"] for e in fetch(client, bob[1])["envelopes"]] == ids[1:]


def test_fetch_pages_are_bounded_in_bytes(
    client: TestClient, db: Database[dict[str, Any]], alice: User
) -> None:
    """500 maximal envelopes would be a ~44 MB response built in memory; a page stops at a
    few MiB of ciphertext instead, and draining page by page still returns everything."""
    own = login(client, alice[0])
    now = datetime.now(UTC)
    documents = [
        {
            "_id": ObjectId(),
            "recipient_device_id": own.id,
            "recipient_user_id": alice[0].id,
            "sender_user_id": alice[0].id,
            "sender_device_id": alice[1].id,
            "nonce": bytes(24),
            "ciphertext": bytes(65_536),
            "size": 65_536,
            "created_at": now,
            "expires_at": now + timedelta(days=30),
        }
        for _ in range(500)
    ]
    db.envelopes.insert_many(documents)
    expected = [str(document["_id"]) for document in documents]

    received: list[str] = []
    while True:
        response = client.get("/v1/envelopes", params={"limit": 500}, headers=own.headers)
        assert response.status_code == 200, response.text
        assert len(response.content) < 6 * 1024 * 1024
        page = [envelope["id"] for envelope in response.json()["envelopes"]]
        if not page:
            break
        received += page
        ack = client.post("/v1/envelopes/ack", json={"ids": page}, headers=own.headers)
        assert ack.status_code == 204
    assert received == expected


def test_a_page_holds_at_least_one_envelope(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, alice: User, bob: User
) -> None:
    monkeypatch.setattr(envelopes_service, "MAX_FETCH_BYTES", 10)
    ids = send_ok(client, alice[1], [outgoing(bob[1].id, size=64) for _ in range(3)])["ids"]
    assert [e["id"] for e in fetch(client, bob[1], limit=500)["envelopes"]] == ids[:1]


class PageReader:
    """The client side of one ``GET /v1/envelopes`` run straight through the app: an ASGI
    ``send`` that records every message and, with ``stall``, stops reading at the first body
    piece until :meth:`release`, like a client that leaves its socket unread."""

    def __init__(self, client: TestClient, *, stall: bool = False) -> None:
        self.client = client
        self.stall = stall
        self.messages: list[Message] = []
        self.stalled = threading.Event()

        async def new_event() -> anyio.Event:
            return anyio.Event()

        self._release = client.portal.call(new_event)

    async def __call__(self, message: Message) -> None:
        self.messages.append(message)
        if self.stall and message["type"] == "http.response.body":
            self.stalled.set()
            await self._release.wait()

    def get(self, device: Device) -> Future[None]:
        """Start the request in the test client's event loop."""
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/v1/envelopes",
            "raw_path": b"/v1/envelopes",
            "root_path": "",
            "query_string": b"limit=500",
            "headers": [
                (b"host", b"testserver"),
                (b"authorization", f"Bearer {device.access_token}".encode()),
            ],
            "client": ("127.0.0.1", 50000),
            "server": ("testserver", 80),
        }
        requested = False

        async def receive() -> Message:
            nonlocal requested
            if not requested:
                requested = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await anyio.sleep_forever()
            return {"type": "http.disconnect"}

        async def run() -> None:
            await self.client.app(scope, receive, self)

        return self.client.portal.start_task_soon(run)

    def release(self) -> None:
        self.client.portal.call(self._release.set)

    def body_pieces(self) -> list[Message]:
        return [message for message in self.messages if message["type"] == "http.response.body"]

    def body(self) -> bytes:
        return b"".join(message["body"] for message in self.body_pieces())


def test_a_page_is_sent_in_pieces(client: TestClient, alice: User) -> None:
    """Handed to the server whole, a page (up to ~5.6 MB of JSON) would stay in its memory for
    as long as the client leaves it unread; sent in pieces, each send waits for the client."""
    own = login(client, alice[0])
    ids = send_ok(client, alice[1], [outgoing(own.id, size=60_000) for _ in range(3)])["ids"]
    reader = PageReader(client)
    reader.get(own).result(10)
    assert reader.messages[0]["type"] == "http.response.start"
    assert reader.messages[0]["status"] == 200
    pieces = reader.body_pieces()
    assert len(pieces) >= 3
    assert all(len(piece["body"]) <= PAGE_CHUNK_BYTES for piece in pieces)
    assert [piece.get("more_body", False) for piece in pieces] == [True] * (len(pieces) - 1) + [
        False
    ]
    assert [envelope["id"] for envelope in json.loads(reader.body())["envelopes"]] == ids


def test_pages_in_flight_are_capped_per_device(client: TestClient, alice: User) -> None:
    """A page stays in server memory until the client has read it, so each device may have
    only a few in flight (the app drains one page at a time); more get 429."""
    other = login(client, alice[0])
    readers = [PageReader(client, stall=True) for _ in range(MAX_PAGES_PER_DEVICE)]
    pending = [reader.get(alice[1]) for reader in readers]
    try:
        assert all(reader.stalled.wait(10) for reader in readers)
        limited = client.get("/v1/envelopes", headers=alice[1].headers)
        assert_error(limited, 429, "rate_limited")
        assert limited.headers["Retry-After"] == "1"
        assert fetch(client, other) == {"envelopes": [], "gap": False}
    finally:
        for reader in readers:
            reader.release()
    for future in pending:
        future.result(10)
    assert all(json.loads(reader.body()) == {"envelopes": [], "gap": False} for reader in readers)
    assert fetch(client, alice[1]) == {"envelopes": [], "gap": False}


def test_a_page_the_client_does_not_read_is_abandoned(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    alice: User,
) -> None:
    """A client that stops reading (or vanished without a FIN) would otherwise keep its page
    in memory, and its device's slot, for as long as the connection lives."""
    caplog.set_level(logging.INFO, logger="fixes_server.middleware")
    monkeypatch.setattr(middleware, "PAGE_SEND_TIMEOUT_SECONDS", 0.2)
    readers = [PageReader(client, stall=True) for _ in range(MAX_PAGES_PER_DEVICE)]
    pending = [reader.get(alice[1]) for reader in readers]
    try:
        for future in pending:
            future.result(5)  # returns although the client never read the page
    finally:
        for reader in readers:
            reader.release()
    assert all(reader.stalled.is_set() for reader in readers)
    abandoned = [r for r in caplog.records if "abandoned an envelope page" in r.getMessage()]
    assert len(abandoned) == MAX_PAGES_PER_DEVICE
    # Both slots are free again.
    assert fetch(client, alice[1]) == {"envelopes": [], "gap": False}


def test_default_fetch_limit_is_100(client: TestClient, alice: User, bob: User) -> None:
    for _ in range(2):
        send_ok(client, alice[1], [outgoing(bob[1].id, size=16) for _ in range(60)])
    assert len(fetch(client, bob[1])["envelopes"]) == 100


def test_ack_deletes_only_the_callers_envelopes(client: TestClient, alice: User, bob: User) -> None:
    bob_tablet = second_linked_device(client, bob)
    to_phone, to_tablet = send_ok(client, alice[1], [outgoing(bob[1].id), outgoing(bob_tablet.id)])[
        "ids"
    ]
    response = client.post(
        "/v1/envelopes/ack",
        json={"ids": [to_phone, to_tablet, secrets.token_hex(12), to_phone]},
        headers=bob[1].headers,
    )
    assert response.status_code == 204
    assert response.content == b""
    assert fetch(client, bob[1])["envelopes"] == []
    assert [e["id"] for e in fetch(client, bob_tablet)["envelopes"]] == [to_tablet]
    # The sender cannot delete what it sent either.
    assert (
        client.post(
            "/v1/envelopes/ack", json={"ids": [to_tablet]}, headers=alice[1].headers
        ).status_code
        == 204
    )
    assert len(fetch(client, bob_tablet)["envelopes"]) == 1


@pytest.mark.parametrize(
    "ids", [[], ["xyz"], ["A" * 24], ["0" * 25], ["0" * 24] * 501, "0" * 24], ids=repr
)
def test_ack_validation(client: TestClient, alice: User, ids: Any) -> None:
    response = client.post("/v1/envelopes/ack", json={"ids": ids}, headers=alice[1].headers)
    assert_error(response, 422, "validation_error")


def test_ack_accepts_500_ids(client: TestClient, alice: User) -> None:
    ids = [secrets.token_hex(12) for _ in range(500)]
    response = client.post("/v1/envelopes/ack", json={"ids": ids}, headers=alice[1].headers)
    assert response.status_code == 204


def test_envelope_indexes(client: TestClient, db: Database[dict[str, Any]]) -> None:
    indexes = {tuple(spec["key"]): spec for spec in db.envelopes.index_information().values()}
    assert (("recipient_device_id", 1), ("_id", 1)) in indexes
    assert (("recipient_device_id", 1), ("sender_user_id", 1)) in indexes
    ttl = indexes[(("expires_at", 1),)]
    assert ttl["expireAfterSeconds"] == 0


def test_envelope_post_rate_limit(make_client: MakeClient) -> None:
    with make_client(rate_limit_envelopes="2/60") as client:
        alice = linked_user(client)
        bob = linked_user(client)
        befriend(client, alice, bob)
        for _ in range(2):
            send_ok(client, alice[1], [outgoing(bob[1].id)])
        limited = send(client, alice[1], [outgoing(bob[1].id)])
        assert_error(limited, 429, "rate_limited")
        assert int(limited.headers["Retry-After"]) >= 1
        # Per user: another sender is unaffected.
        send_ok(client, bob[1], [outgoing(alice[1].id)])


def test_recipient_revoked_during_the_send_keeps_no_envelopes(
    client: TestClient,
    db: Database[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    alice: User,
    bob: User,
) -> None:
    """A revocation between the recipient check and the insert must not leave envelopes for
    the revoked device until the TTL (its own cleanup ran before they existed)."""
    real_check = envelopes_service._check_recipients

    async def check_then_revoke(*args: Any, **kwargs: Any) -> Any:
        recipients = await real_check(*args, **kwargs)
        db.devices.update_one({"_id": bob[1].id}, {"$set": {"revoked_at": datetime.now(UTC)}})
        return recipients

    monkeypatch.setattr(envelopes_service, "_check_recipients", check_then_revoke)
    own = login(client, alice[0])
    result = send_ok(client, alice[1], [outgoing(bob[1].id), outgoing(own.id)])
    assert None not in result["ids"]
    assert db.envelopes.count_documents({"recipient_device_id": bob[1].id}) == 0
    assert db.envelopes.count_documents({"recipient_device_id": own.id}) == 1
