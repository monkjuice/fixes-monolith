"""Reusable test helpers: accounts, devices with real X25519 keys, identities with real Ed25519
keys, friendships, images, a hooks recorder, envelopes and WebSocket sessions."""

from __future__ import annotations

import base64
import io
import json
import secrets
import struct
import threading
from collections.abc import Collection, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import anyio
import httpx
from bson import ObjectId
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from PIL import Image
from pymongo.database import Database
from starlette.testclient import TestClient, WebSocketTestSession
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.websockets import WebSocketDisconnect

from fixes_server.context import AppContext
from fixes_server.hooks import DeviceEventHooks
from fixes_server.security.keys import device_certificate_message

CLIENT_IP_HEADER = "X-Test-Client-IP"


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def random_username(prefix: str = "u") -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def random_password() -> str:
    return secrets.token_urlsafe(18)


def new_device_key() -> tuple[X25519PrivateKey, str]:
    private = X25519PrivateKey.generate()
    return private, b64(private.public_key().public_bytes_raw())


@dataclass
class Device:
    id: str
    name: str
    private_key: X25519PrivateKey
    public_key: str
    access_token: str
    refresh_token: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}


@dataclass
class Account:
    id: str
    username: str
    password: str
    identity: Ed25519PrivateKey | None = None
    devices: list[Device] = field(default_factory=list)

    @property
    def identity_key(self) -> str:
        if self.identity is None:
            raise ValueError("account has no identity yet")
        return b64(self.identity.public_key().public_bytes_raw())


def assert_error(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    """Assert the §5.1 error shape and return ``error.details``."""
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error"}, body
    error = body["error"]
    assert set(error) == {"code", "message", "details"}, error
    assert error["code"] == code, error
    assert isinstance(error["message"], str)
    assert error["message"]
    assert isinstance(error["details"], dict)
    return dict(error["details"])


def register(
    client: TestClient, username: str | None = None, password: str | None = None
) -> Account:
    username = username or random_username()
    password = password or random_password()
    response = client.post("/v1/auth/register", json={"username": username, "password": password})
    assert response.status_code == 201, response.text
    return Account(id=response.json()["user"]["id"], username=username, password=password)


def login_request(
    client: TestClient,
    username: str,
    password: str,
    public_key: str,
    *,
    name: str = "Test phone",
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    return client.post(
        "/v1/auth/login",
        json={
            "username": username,
            "password": password,
            "device": {"name": name, "public_key": public_key},
        },
        headers=headers,
    )


def login(client: TestClient, account: Account, name: str = "Test phone") -> Device:
    private, public = new_device_key()
    response = login_request(client, account.username, account.password, public, name=name)
    assert response.status_code == 200, response.text
    body = response.json()
    device = Device(
        id=body["device"]["id"],
        name=name,
        private_key=private,
        public_key=public,
        access_token=body["access_token"],
        refresh_token=body["refresh_token"],
    )
    account.devices.append(device)
    return device


def make_certificate(
    identity: Ed25519PrivateKey, user_id: str, device_id: str, device_public_key: str
) -> str:
    return b64(identity.sign(device_certificate_message(user_id, device_id, device_public_key)))


def set_identity(client: TestClient, account: Account, device: Device) -> httpx.Response:
    """Create the account identity on ``device`` (first device, self-certified)."""
    identity = Ed25519PrivateKey.generate()
    public = b64(identity.public_key().public_bytes_raw())
    response = client.put(
        "/v1/users/me/identity",
        json={
            "identity_key": public,
            "device_certificate": make_certificate(
                identity, account.id, device.id, device.public_key
            ),
        },
        headers=device.headers,
    )
    assert response.status_code == 200, response.text
    account.identity = identity
    return response


def certify(client: TestClient, account: Account, by: Device, target: Device) -> httpx.Response:
    """Certify ``target`` with the account identity, authenticated as ``by``."""
    if account.identity is None:
        raise ValueError("account has no identity yet")
    certificate = make_certificate(account.identity, account.id, target.id, target.public_key)
    return client.put(
        f"/v1/devices/{target.id}/certificate",
        json={"certificate": certificate},
        headers=by.headers,
    )


def linked_user(client: TestClient, username: str | None = None) -> tuple[Account, Device]:
    """Register, log in and create the identity: a user with one linked device."""
    account = register(client, username)
    device = login(client, account)
    set_identity(client, account, device)
    return account, device


def befriend(client: TestClient, a: tuple[Account, Device], b: tuple[Account, Device]) -> None:
    first = client.post("/v1/friend-requests", json={"to_user_id": b[0].id}, headers=a[1].headers)
    assert first.status_code == 201, first.text
    second = client.post("/v1/friend-requests", json={"to_user_id": a[0].id}, headers=b[1].headers)
    assert second.status_code == 200, second.text


def app_context(client: TestClient) -> AppContext:
    app: Any = client.app
    while not hasattr(app, "state"):
        app = app.app
    ctx: AppContext = app.state.ctx
    return ctx


@dataclass
class PausedPasswordCheck:
    reached: threading.Event
    release: threading.Event


@contextmanager
def pause_first_password_check(client: TestClient) -> Iterator[PausedPasswordCheck]:
    """Hold the next argon2 verification in its worker thread, after it has decided, until
    ``release`` is set: the request that made it is then in flight past its password check.

    Start that request on another thread, wait for ``reached``, act, then set ``release``.
    Later verifications run normally.
    """
    passwords: Any = app_context(client).passwords
    real = passwords._verify_sync
    paused = PausedPasswordCheck(reached=threading.Event(), release=threading.Event())
    lock = threading.Lock()
    first = True

    def verify(password_hash: str, password: str) -> bool:
        nonlocal first
        ok: bool = real(password_hash, password)
        with lock:
            pause, first = first, False
        if pause:
            paused.reached.set()
            paused.release.wait(30)
        return ok

    passwords._verify_sync = verify  # an instance attribute shadows the method
    try:
        yield paused
    finally:
        paused.release.set()
        del passwords._verify_sync


def image_bytes(fmt: str, size: tuple[int, int], *, color: str = "red", **save: Any) -> bytes:
    image = Image.new("RGB", size, color)
    output = io.BytesIO()
    image.save(output, format=fmt, **save)
    return output.getvalue()


def jpeg_segment(marker: int, payload: bytes) -> bytes:
    return struct.pack(">HH", marker, len(payload) + 2) + payload


def _entropy_bits(bits: str) -> bytes:
    """Pack a bit string as entropy-coded data: padded with 1 bits, 0xFF stuffed with 0x00."""
    bits += "1" * (-len(bits) % 8)
    out = bytearray()
    for i in range(0, len(bits), 8):
        out.append(int(bits[i : i + 8], 2))
        if out[-1] == 0xFF:
            out.append(0x00)
    return bytes(out)


def scan_heavy_jpeg(width: int, height: int, ac_scans: int) -> bytes:
    """A valid progressive grayscale JPEG with one DC scan and ``ac_scans`` empty AC scans.

    Each empty scan is a few bytes (one end-of-band run over every block), but the decoder
    still makes a pass over the whole image for it: thousands of them fit in an upload.
    """
    blocks = ((width + 7) // 8) * ((height + 7) // 8)
    run_bits = blocks.bit_length() - 1  # EOBr codes runs of 2**r .. 2**(r + 1) - 1 blocks
    assert run_bits <= 14
    one_code = bytes([1] + [0] * 15)  # a single 1-bit Huffman code, "0"
    data = b"\xff\xd8"
    data += jpeg_segment(0xFFDB, b"\x00" + bytes([1] * 64))
    data += jpeg_segment(0xFFC2, struct.pack(">BHHB", 8, height, width, 1) + bytes([1, 0x11, 0]))
    data += jpeg_segment(0xFFC4, b"\x00" + one_code + b"\x00")  # DC: category 0
    data += jpeg_segment(0xFFC4, b"\x10" + one_code + bytes([run_bits << 4]))  # AC: EOBr
    data += jpeg_segment(0xFFDA, bytes([1, 1, 0x00, 0, 0, 0])) + _entropy_bits("0" * blocks)
    extra = format(blocks - (1 << run_bits), f"0{run_bits}b") if run_bits else ""
    empty_scan = jpeg_segment(0xFFDA, bytes([1, 1, 0x00, 1, 63, 0])) + _entropy_bits("0" + extra)
    return data + empty_scan * ac_scans + b"\xff\xd9"


class RecordingHooks(DeviceEventHooks):
    """Records lifecycle hook calls (after the real realtime hooks ran) for assertions."""

    def __init__(self) -> None:
        self.events: list[tuple[Any, ...]] = []

    async def delete_pending_envelopes(self, device_ids: Sequence[str]) -> None:
        self.events.append(("delete_pending_envelopes", tuple(device_ids)))

    async def close_device_sockets(self, device_ids: Sequence[str]) -> None:
        self.events.append(("close_device_sockets", tuple(device_ids)))

    async def notify_devices_changed(
        self, user_id: str, *, exclude_device_ids: Collection[str] = ()
    ) -> None:
        self.events.append(("devices_changed", user_id, tuple(sorted(exclude_device_ids))))

    def names(self) -> list[str]:
        return [event[0] for event in self.events]


class ClientIpOverride:
    """Test stand-in for Uvicorn's trusted proxy headers: sets the peer from a test header."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in {"http", "websocket"}:
            for name, value in scope.get("headers", ()):
                if name == CLIENT_IP_HEADER.lower().encode():
                    scope = {**scope, "client": (value.decode("latin-1"), 50000)}
        await self.app(scope, receive, send)


# --- Envelopes -------------------------------------------------------------------------------


def outgoing(recipient_device_id: str, *, size: int = 272) -> dict[str, str]:
    """One envelope for ``POST /v1/envelopes`` with random (opaque) nonce and ciphertext."""
    return {
        "recipient_device_id": recipient_device_id,
        "nonce": b64(secrets.token_bytes(24)),
        "ciphertext": b64(secrets.token_bytes(size)),
    }


def send(
    client: TestClient,
    sender: Device,
    envelopes: Sequence[dict[str, str]],
    complete_for: Sequence[str] | None = None,
) -> httpx.Response:
    body: dict[str, Any] = {"envelopes": list(envelopes)}
    if complete_for is not None:
        body["complete_for_user_ids"] = list(complete_for)
    return client.post("/v1/envelopes", json=body, headers=sender.headers)


def send_ok(
    client: TestClient,
    sender: Device,
    envelopes: Sequence[dict[str, str]],
    complete_for: Sequence[str] | None = None,
) -> dict[str, Any]:
    response = send(client, sender, envelopes, complete_for)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def fetch(client: TestClient, device: Device, **params: Any) -> dict[str, Any]:
    response = client.get("/v1/envelopes", params=params, headers=device.headers)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def fill_mailbox(
    db: Database[dict[str, Any]],
    recipient_device_id: str,
    recipient_user_id: str,
    count: int,
    *,
    sender_user_id: str,
    sender_device_id: str,
) -> None:
    """Store ``count`` pending envelopes directly, to reach the mailbox caps quickly."""
    now = datetime.now(UTC)
    db.envelopes.insert_many(
        {
            "_id": ObjectId(),
            "recipient_device_id": recipient_device_id,
            "recipient_user_id": recipient_user_id,
            "sender_user_id": sender_user_id,
            "sender_device_id": sender_device_id,
            "nonce": bytes(24),
            "ciphertext": bytes(16),
            "size": 16,
            "created_at": now,
            "expires_at": now + timedelta(days=30),
        }
        for _ in range(count)
    )


# --- WebSockets --------------------------------------------------------------------------------


def ws_receive(ws: WebSocketTestSession, timeout: float = 5.0) -> dict[str, Any]:
    """Like ``receive_json`` but fails after ``timeout`` instead of hanging the suite.

    Starlette's session has no timeout of its own, so this reads its private stream through
    the session's portal; a close frame raises WebSocketDisconnect with the close code.
    """

    async def receive() -> Message:
        with anyio.fail_after(timeout):
            message: Message = await ws._send_rx.receive()
            return message

    message = ws.portal.call(receive)
    ws._raise_on_close(message)
    frame: dict[str, Any] = json.loads(message["text"])
    return frame


def ws_expect_close(ws: WebSocketTestSession, timeout: float = 5.0) -> int:
    """The next message must be the server's close frame; returns its close code."""
    try:
        frame = ws_receive(ws, timeout)
    except WebSocketDisconnect as closed:
        return closed.code
    raise AssertionError(f"expected the socket to close, got {frame}")


@dataclass
class LiveSocket:
    ws: WebSocketTestSession
    gap: bool

    def receive(self, timeout: float = 5.0) -> dict[str, Any]:
        return ws_receive(self.ws, timeout)

    def send(self, frame: dict[str, Any]) -> None:
        self.ws.send_json(frame)

    def sync(self) -> None:
        """Ping and wait for the pong: every frame sent before has been processed, and
        nothing else was queued for this socket in the meantime."""
        self.send({"type": "ping"})
        assert self.receive() == {"type": "pong"}

    def expect_close(self, timeout: float = 5.0) -> int:
        return ws_expect_close(self.ws, timeout)


@contextmanager
def live_socket(
    client: TestClient, device: Device, *, headers: dict[str, str] | None = None
) -> Iterator[LiveSocket]:
    """An authenticated ``/v1/ws`` session that has received ``ready``."""
    with client.websocket_connect("/v1/ws", headers=dict(headers or {})) as ws:
        ws.send_json({"type": "auth", "token": device.access_token})
        ready = ws_receive(ws)
        assert ready["type"] == "ready", ready
        assert set(ready) == {"type", "gap"}
        yield LiveSocket(ws=ws, gap=ready["gap"])
