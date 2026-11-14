"""Mailbox caps, partial overflow and the one-time gap flag (protocol §5.3, §6)."""

from __future__ import annotations

from typing import Any

import pytest
from pymongo.database import Database
from starlette.testclient import TestClient

from fixes_server.services.envelopes import MAX_PENDING_PER_DEVICE, MAX_PENDING_PER_SENDER
from tests.helpers import (
    Account,
    Device,
    befriend,
    certify,
    fetch,
    fill_mailbox,
    linked_user,
    live_socket,
    login,
    outgoing,
    send_ok,
)

User = tuple[Account, Device]


@pytest.fixture
def alice(client: TestClient) -> User:
    return linked_user(client)


@pytest.fixture
def bob(client: TestClient, alice: User) -> User:
    user = linked_user(client)
    befriend(client, alice, user)
    return user


def gap_of(client: TestClient, device: Device) -> bool:
    gap: bool = fetch(client, device, limit=1)["gap"]
    return gap


def test_device_cap_drops_overflow_and_reports_gap_once(
    client: TestClient, db: Database[dict[str, Any]], alice: User, bob: User
) -> None:
    bob_tablet = login(client, bob[0])
    assert certify(client, bob[0], bob[1], bob_tablet).status_code == 200
    # Bob's own tablet filled the phone's mailbox to one below the device cap.
    fill_mailbox(
        db,
        bob[1].id,
        bob[0].id,
        MAX_PENDING_PER_DEVICE - 1,
        sender_user_id=bob[0].id,
        sender_device_id=bob_tablet.id,
    )

    batch = [outgoing(bob[1].id), outgoing(bob[1].id), outgoing(bob_tablet.id)]
    result = send_ok(client, alice[1], batch)
    first, dropped, to_tablet = result["ids"]
    assert first is not None
    assert dropped is None  # the cap is enforced inside one batch too
    assert to_tablet is not None  # other devices of the batch are unaffected
    assert result["dropped_device_ids"] == [bob[1].id]
    assert db.envelopes.count_documents({"recipient_device_id": bob[1].id}) == (
        MAX_PENDING_PER_DEVICE
    )
    stored = db.devices.find_one({"_id": bob[1].id})
    assert stored is not None
    assert stored["overflow_at"] is not None

    # The gap is reported exactly once: here on GET, so the next socket sees none.
    assert gap_of(client, bob[1]) is True
    assert gap_of(client, bob[1]) is False
    with live_socket(client, bob[1]) as socket:
        assert socket.gap is False
        socket.sync()
    assert gap_of(client, bob_tablet) is False

    # Own devices are capped as well (only the per-sender cap is for other users).
    result = send_ok(client, bob_tablet, [outgoing(bob[1].id)])
    assert result["ids"] == [None]
    assert result["dropped_device_ids"] == [bob[1].id]

    # This time the WebSocket ready frame reports it, and GET no longer does.
    with live_socket(client, bob[1]) as socket:
        assert socket.gap is True
        socket.sync()
    with live_socket(client, bob[1]) as socket:
        assert socket.gap is False
        socket.sync()
    assert gap_of(client, bob[1]) is False

    # Draining makes room again.
    ids = [e["id"] for e in fetch(client, bob[1], limit=10)["envelopes"]]
    acked = client.post("/v1/envelopes/ack", json={"ids": ids}, headers=bob[1].headers)
    assert acked.status_code == 204
    result = send_ok(client, alice[1], [outgoing(bob[1].id)])
    assert result["ids"][0] is not None
    assert result["dropped_device_ids"] == []
    assert gap_of(client, bob[1]) is False


def test_per_sender_cap_limits_each_other_user(
    client: TestClient, db: Database[dict[str, Any]], alice: User, bob: User
) -> None:
    carol = linked_user(client)
    befriend(client, carol, bob)
    bob_tablet = login(client, bob[0])
    assert certify(client, bob[0], bob[1], bob_tablet).status_code == 200
    fill_mailbox(
        db,
        bob[1].id,
        bob[0].id,
        MAX_PENDING_PER_SENDER - 1,
        sender_user_id=alice[0].id,
        sender_device_id=alice[1].id,
    )

    result = send_ok(
        client,
        alice[1],
        [outgoing(bob[1].id), outgoing(bob[1].id), outgoing(bob_tablet.id)],
    )
    assert result["ids"][0] is not None
    assert result["ids"][1] is None
    assert result["ids"][2] is not None
    assert result["dropped_device_ids"] == [bob[1].id]

    # Other senders still get through: the cap is per sending user.
    assert send_ok(client, carol[1], [outgoing(bob[1].id)])["ids"][0] is not None
    # Bob's own devices are not limited by the per-sender cap (sync copies, history).
    own = send_ok(client, bob_tablet, [outgoing(bob[1].id) for _ in range(3)])
    assert None not in own["ids"]
    assert own["dropped_device_ids"] == []

    assert gap_of(client, bob[1]) is True
    assert gap_of(client, bob[1]) is False


def test_dropped_device_ids_are_unique_and_in_batch_order(
    client: TestClient, db: Database[dict[str, Any]], alice: User, bob: User
) -> None:
    bob_tablet = login(client, bob[0])
    assert certify(client, bob[0], bob[1], bob_tablet).status_code == 200
    for device in (bob_tablet, bob[1]):
        fill_mailbox(
            db,
            device.id,
            bob[0].id,
            MAX_PENDING_PER_SENDER,
            sender_user_id=alice[0].id,
            sender_device_id=alice[1].id,
        )
    batch = [outgoing(bob_tablet.id), outgoing(bob[1].id), outgoing(bob_tablet.id)]
    result = send_ok(client, alice[1], batch)
    assert result["ids"] == [None, None, None]
    assert result["dropped_device_ids"] == [bob_tablet.id, bob[1].id]
