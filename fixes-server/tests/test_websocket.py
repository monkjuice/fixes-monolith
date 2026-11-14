"""``/v1/ws`` (protocol §6): authentication, ready, ping/pong, pushes, acks and close codes."""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime, timedelta
from typing import Any

import anyio
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pymongo.database import Database
from starlette.testclient import TestClient, WebSocketDenialResponse
from starlette.types import Message

from fixes_server.realtime import session
from fixes_server.realtime.protocol import CLOSE_REPLACED
from fixes_server.routers import ws as ws_router
from tests.conftest import MakeClient
from tests.helpers import (
    CLIENT_IP_HEADER,
    app_context,
    b64,
    befriend,
    certify,
    fetch,
    linked_user,
    live_socket,
    login,
    make_certificate,
    outgoing,
    register,
    send_ok,
    set_identity,
    ws_expect_close,
    ws_receive,
)


def test_auth_ready_and_last_seen(client: TestClient, db: Database[dict[str, Any]]) -> None:
    _, device = linked_user(client)
    old = datetime.now(UTC) - timedelta(minutes=10)
    db.devices.update_one({"_id": device.id}, {"$set": {"last_seen_at": old}})

    with live_socket(client, device) as socket:
        assert socket.gap is False
        socket.sync()

    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    # WebSocket auth always records last_seen_at, unlike the hourly touch of REST calls.
    assert stored["last_seen_at"] > old + timedelta(minutes=9)


def test_ping_pong_and_unknown_frames(client: TestClient) -> None:
    _, device = linked_user(client)
    with live_socket(client, device) as socket:
        socket.send({"type": "ping"})
        assert socket.receive() == {"type": "pong"}
        # Unknown types and a repeated auth are ignored, the socket stays usable.
        socket.send({"type": "something_new", "x": 1})
        socket.send({"type": "auth", "token": device.access_token})
        socket.sync()


def test_bad_tokens_close_with_4401(client: TestClient) -> None:
    account, _ = linked_user(client)
    other = login(client, account)
    assert client.post("/v1/auth/logout", headers=other.headers).status_code == 204

    for token in ["not-a-jwt", other.access_token, "", None, 42]:
        with client.websocket_connect("/v1/ws") as ws:
            ws.send_json({"type": "auth", "token": token})
            assert ws_expect_close(ws) == 4401

    with client.websocket_connect("/v1/ws") as ws:
        ws.send_json({"type": "auth"})
        assert ws_expect_close(ws) == 4401


def test_first_frame_must_be_auth(client: TestClient) -> None:
    _, device = linked_user(client)
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_json({"type": "ping"})
        assert ws_expect_close(ws) == 1008
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_text("{not json")
        assert ws_expect_close(ws) == 1008
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_json(["auth", device.access_token])
        assert ws_expect_close(ws) == 1008
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_bytes(b'{"type":"auth"}')
        assert ws_expect_close(ws) == 1003
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_text(" " * 70_000)
        assert ws_expect_close(ws) == 1009


def test_auth_timeout_closes_with_4408(make_client: MakeClient) -> None:
    with (
        make_client(ws_auth_timeout_seconds=0.2) as client,
        client.websocket_connect("/v1/ws") as ws,
    ):
        assert ws_expect_close(ws) == 4408


def test_live_push_on_post(client: TestClient) -> None:
    alice = linked_user(client)
    bob = linked_user(client)
    befriend(client, alice, bob)
    bob_tablet = login(client, bob[0])
    assert certify(client, bob[0], bob[1], bob_tablet).status_code == 200

    with live_socket(client, bob[1]) as phone, live_socket(client, bob_tablet) as tablet:
        envelopes = [outgoing(bob[1].id), outgoing(bob_tablet.id)]
        result = send_ok(client, alice[1], envelopes, complete_for=[bob[0].id, alice[0].id])

        pushed = phone.receive()
        assert pushed["type"] == "envelope"
        assert pushed["envelope"] == {
            "id": result["ids"][0],
            "sender_user_id": alice[0].id,
            "sender_device_id": alice[1].id,
            "recipient_device_id": bob[1].id,
            "nonce": envelopes[0]["nonce"],
            "ciphertext": envelopes[0]["ciphertext"],
            "created_at": result["created_at"],
        }
        assert tablet.receive()["envelope"]["id"] == result["ids"][1]
        # The push carries exactly what GET /v1/envelopes returns; it does not replace it.
        assert fetch(client, bob[1])["envelopes"] == [pushed["envelope"]]
        phone.sync()
        tablet.sync()


def test_pending_envelopes_are_not_replayed_on_connect(client: TestClient) -> None:
    alice = linked_user(client)
    bob = linked_user(client)
    befriend(client, alice, bob)
    send_ok(client, alice[1], [outgoing(bob[1].id)])
    with live_socket(client, bob[1]) as socket:
        # ready is followed directly by the pong: nothing was replayed (§6.2).
        socket.sync()
    assert len(fetch(client, bob[1])["envelopes"]) == 1


def test_ack_over_websocket(client: TestClient) -> None:
    alice = linked_user(client)
    bob = linked_user(client)
    befriend(client, alice, bob)
    with live_socket(client, bob[1]) as socket:
        first, second = send_ok(client, alice[1], [outgoing(bob[1].id), outgoing(bob[1].id)])["ids"]
        assert socket.receive()["envelope"]["id"] == first
        assert socket.receive()["envelope"]["id"] == second
        socket.send({"type": "ack", "ids": [first]})
        socket.sync()  # frames are handled in order, so the ack is done after the pong
        assert [e["id"] for e in fetch(client, bob[1])["envelopes"]] == [second]


@pytest.mark.parametrize(
    "ids", [[], ["xyz"], ["A" * 24], ["0" * 24] * 501, "0" * 24, None], ids=repr
)
def test_invalid_ack_frame_closes_with_1008(client: TestClient, ids: Any) -> None:
    _, device = linked_user(client)
    with live_socket(client, device) as socket:
        socket.send({"type": "ack", "ids": ids})
        assert socket.expect_close() == 1008


def test_new_socket_replaces_older_one_with_4409(client: TestClient) -> None:
    alice = linked_user(client)
    bob = linked_user(client)
    befriend(client, alice, bob)
    with live_socket(client, bob[1]) as first, live_socket(client, bob[1]) as second:
        assert first.expect_close() == 4409
        # The replaced socket's handler has finished without unregistering its successor:
        # pushes go to the newer socket.
        sent = send_ok(client, alice[1], [outgoing(bob[1].id)])
        assert second.receive()["envelope"]["id"] == sent["ids"][0]
        second.sync()
    assert len(app_context(client).realtime) == 0


def test_devices_changed_on_login_certificate_and_revoke(client: TestClient) -> None:
    account, phone = linked_user(client)
    with live_socket(client, phone) as socket:
        tablet = login(client, account, name="Tablet")
        assert socket.receive() == {"type": "devices_changed"}

        assert certify(client, account, phone, tablet).status_code == 200
        assert socket.receive() == {"type": "devices_changed"}

        response = client.delete(f"/v1/devices/{tablet.id}", headers=phone.headers)
        assert response.status_code == 204
        assert socket.receive() == {"type": "devices_changed"}
        socket.sync()


def test_devices_changed_on_identity_set_and_reset(client: TestClient) -> None:
    account = register(client)
    first = login(client, account)
    second = login(client, account)
    with live_socket(client, first) as first_socket, live_socket(client, second) as second_socket:
        set_identity(client, account, first)
        assert first_socket.receive() == {"type": "devices_changed"}
        assert second_socket.receive() == {"type": "devices_changed"}

        # Reset from the second device: the first is revoked (4401), the second notified.
        identity = Ed25519PrivateKey.generate()
        response = client.post(
            "/v1/auth/reset-identity",
            json={
                "password": account.password,
                "identity_key": b64(identity.public_key().public_bytes_raw()),
                "device_certificate": make_certificate(
                    identity, account.id, second.id, second.public_key
                ),
            },
            headers=second.headers,
        )
        assert response.status_code == 200, response.text
        assert first_socket.expect_close() == 4401
        assert second_socket.receive() == {"type": "devices_changed"}
        second_socket.sync()


def test_revocation_deletes_envelopes_and_closes_socket(
    client: TestClient, db: Database[dict[str, Any]]
) -> None:
    alice = linked_user(client)
    bob = linked_user(client)
    befriend(client, alice, bob)
    bob_tablet = login(client, bob[0])
    assert certify(client, bob[0], bob[1], bob_tablet).status_code == 200

    with live_socket(client, bob[1]) as phone, live_socket(client, bob_tablet) as tablet:
        sent = send_ok(client, alice[1], [outgoing(bob_tablet.id)])
        assert tablet.receive()["envelope"]["id"] == sent["ids"][0]
        assert db.envelopes.count_documents({"recipient_device_id": bob_tablet.id}) == 1

        response = client.delete(f"/v1/devices/{bob_tablet.id}", headers=bob[1].headers)
        assert response.status_code == 204
        assert tablet.expect_close() == 4401
        assert phone.receive() == {"type": "devices_changed"}
        assert db.envelopes.count_documents({"recipient_device_id": bob_tablet.id}) == 0
        phone.sync()

    # The revoked device cannot come back.
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_json({"type": "auth", "token": bob_tablet.access_token})
        assert ws_expect_close(ws) == 4401


def test_logout_closes_own_socket(client: TestClient) -> None:
    _, device = linked_user(client)
    with live_socket(client, device) as socket:
        assert client.post("/v1/auth/logout", headers=device.headers).status_code == 204
        assert socket.expect_close() == 4401


def test_revocation_racing_the_handshake_is_caught(
    client: TestClient, db: Database[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A revocation between the token check and registration finds no socket to close; the
    conditional last_seen_at update after registration must notice it instead."""
    _, device = linked_user(client)
    real = session.authenticate_access_token

    async def authenticate_then_revoke(*args: Any, **kwargs: Any) -> Any:
        principal = await real(*args, **kwargs)
        db.devices.update_one({"_id": device.id}, {"$set": {"revoked_at": datetime.now(UTC)}})
        return principal

    monkeypatch.setattr(session, "authenticate_access_token", authenticate_then_revoke)
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_json({"type": "auth", "token": device.access_token})
        assert ws_expect_close(ws) == 4401


def test_connect_rate_limit_per_ip(make_client: MakeClient) -> None:
    with make_client(rate_limit_ws_connect="2/60") as client:
        _, device = linked_user(client)
        for _ in range(2):
            with live_socket(client, device) as socket:
                socket.sync()
        with pytest.raises(WebSocketDenialResponse) as denied:
            client.websocket_connect("/v1/ws").__enter__()
        assert denied.value.status_code == 429
        assert denied.value.json()["error"]["code"] == "rate_limited"
        assert int(denied.value.headers["Retry-After"]) >= 1
        # The limit is per IP.
        with live_socket(client, device, headers={CLIENT_IP_HEADER: "203.0.113.7"}) as socket:
            socket.sync()


def test_unauthenticated_sockets_are_capped_per_ip(make_client: MakeClient) -> None:
    with make_client(ws_max_unauthenticated_per_ip=2) as client:
        _, device = linked_user(client)
        with client.websocket_connect("/v1/ws") as first, client.websocket_connect("/v1/ws"):
            with pytest.raises(WebSocketDenialResponse) as denied:
                client.websocket_connect("/v1/ws").__enter__()
            assert denied.value.status_code == 429
            assert denied.value.json()["error"]["code"] == "rate_limited"

            # Another IP has its own allowance.
            other_ip = {CLIENT_IP_HEADER: "203.0.113.8"}
            with live_socket(client, device, headers=other_ip) as socket:
                socket.sync()

            # Authenticating frees the slot.
            first.send_json({"type": "auth", "token": device.access_token})
            assert ws_receive(first)["type"] == "ready"
            with client.websocket_connect("/v1/ws") as third:
                third.send_json({"type": "ping"})
                assert ws_expect_close(third) == 1008


def test_ipv6_connects_are_limited_by_their_64(make_client: MakeClient) -> None:
    with make_client(rate_limit_ws_connect="1/60") as client:
        _, device = linked_user(client)
        with live_socket(client, device, headers={CLIENT_IP_HEADER: "2001:db8::1"}) as socket:
            socket.sync()
        same_64 = {CLIENT_IP_HEADER: "2001:db8::2"}
        # A with block, so that a wrongly accepted socket is closed and the test fails cleanly.
        with (
            pytest.raises(WebSocketDenialResponse) as denied,
            client.websocket_connect("/v1/ws", headers=same_64),
        ):
            pass
        assert denied.value.status_code == 429
        with live_socket(client, device, headers={CLIENT_IP_HEADER: "2001:db8:0:1::5"}) as socket:
            socket.sync()


# Deep enough to exhaust the JSON parser's recursion limit, small enough for the 64 KiB cap.
DEEPLY_NESTED = "[" * 20_000 + "]" * 20_000


def test_deeply_nested_frames_are_a_protocol_violation(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    _, device = linked_user(client)
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_text(DEEPLY_NESTED)
        assert ws_expect_close(ws) == 1008
    with live_socket(client, device) as socket:
        socket.ws.send_text(DEEPLY_NESTED)
        assert socket.expect_close() == 1008
    assert not [record for record in caplog.records if record.levelno >= logging.ERROR]


@pytest.mark.parametrize("replaced", ["before_take_gap", "after_take_gap"])
def test_gap_is_kept_when_the_socket_is_replaced_before_ready(
    client: TestClient,
    db: Database[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    replaced: str,
) -> None:
    """A socket closed during its handshake never sends ready, so it must not consume the
    one-time gap report (§5.3): the device's next socket or GET still reports it."""
    _, device = linked_user(client)
    db.devices.update_one({"_id": device.id}, {"$set": {"overflow_at": datetime.now(UTC)}})
    ctx = app_context(client)

    def replace_socket() -> None:
        connection = ctx.realtime.get(device.id)
        assert connection is not None
        connection.close(CLOSE_REPLACED, "replaced by a newer connection")

    if replaced == "before_take_gap":
        real_utcnow = session.utcnow

        def replaced_then_now() -> datetime:  # called for the last_seen_at update
            replace_socket()
            return real_utcnow()

        monkeypatch.setattr(session, "utcnow", replaced_then_now)
    else:
        real_take_gap = session.take_gap

        async def take_gap_then_replaced(*args: Any) -> bool:
            gap = await real_take_gap(*args)
            replace_socket()
            return gap

        monkeypatch.setattr(session, "take_gap", take_gap_then_replaced)

    with client.websocket_connect("/v1/ws") as ws:
        ws.send_json({"type": "auth", "token": device.access_token})
        assert ws_expect_close(ws) == 4409  # closed without ready
    monkeypatch.undo()

    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    assert stored["overflow_at"] is not None
    with live_socket(client, device) as socket:
        assert socket.gap is True
        socket.sync()
    assert fetch(client, device)["gap"] is False


def test_a_client_gone_before_ready_is_not_a_server_error(
    client: TestClient,
    db: Database[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A client that drops between its auth frame and ready (common on mobile) is a normal
    disconnect, not a server fault: no ERROR record, and the gap is kept for the next socket."""
    _, device = linked_user(client)
    db.devices.update_one({"_id": device.id}, {"$set": {"overflow_at": datetime.now(UTC)}})
    finished = threading.Event()
    real_serve_socket = ws_router.serve_socket

    async def serve_with_client_gone_before_ready(ctx: Any, websocket: Any) -> None:
        real_send = websocket._send

        async def send(message: Message) -> None:
            if str(message.get("text", "")).startswith('{"type":"ready"'):
                # What Uvicorn raises for a vanished peer (ClientDisconnected is an OSError);
                # Starlette turns it into WebSocketDisconnect(1006).
                raise OSError("client disconnected")
            await real_send(message)

        websocket._send = send
        try:
            await real_serve_socket(ctx, websocket)
        finally:
            finished.set()

    monkeypatch.setattr(ws_router, "serve_socket", serve_with_client_gone_before_ready)
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_json({"type": "auth", "token": device.access_token})
        assert finished.wait(5)
    monkeypatch.undo()

    assert not [record for record in caplog.records if record.levelno >= logging.ERROR]
    stored = db.devices.find_one({"_id": device.id})
    assert stored is not None
    assert stored["overflow_at"] is not None
    with live_socket(client, device) as socket:
        assert socket.gap is True
        socket.sync()


def test_a_late_handshake_does_not_replace_a_newer_socket(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """4409 means "replaced by a newer socket" (§6): when the client gave up on a slow
    handshake and opened another socket, the abandoned one finishing later must not take
    the device over (the client would stay offline until the next foreground)."""
    _, device = linked_user(client)
    ctx = app_context(client)

    async def new_event() -> anyio.Event:
        return anyio.Event()

    release = client.portal.call(new_event)
    stuck = threading.Event()
    real_authenticate = session.authenticate_access_token
    calls = 0

    async def slow_first(*args: Any, **kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 1:
            stuck.set()
            await release.wait()
        return await real_authenticate(*args, **kwargs)

    monkeypatch.setattr(session, "authenticate_access_token", slow_first)
    with client.websocket_connect("/v1/ws") as older:
        older.send_json({"type": "auth", "token": device.access_token})
        assert stuck.wait(5)
        with live_socket(client, device) as newer:
            current = ctx.realtime.get(device.id)
            assert current is not None
            client.portal.call(release.set)
            assert ws_expect_close(older) == 4409
            newer.sync()
            assert ctx.realtime.get(device.id) is current
