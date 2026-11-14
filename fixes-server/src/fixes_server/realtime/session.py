"""One ``/v1/ws`` connection (protocol §6).

1. Before accepting: per-IP connect rate limit and a cap on concurrent unauthenticated
   sockets per IP (§5.6); refusals are HTTP 429 denial responses with the §5.1 body.
2. The first frame must be ``{"type":"auth","token":...}`` within the auth timeout (4408);
   a bad token or a revoked device closes with 4401.
3. Register the socket (of two sockets of the same device, the one opened first is closed
   with 4409), record ``last_seen_at``, then send ``{"type":"ready","gap":...}``.
4. Serve: pushes from the connection's queue on one task, client frames (ping, ack) on the
   other. Closing requested from elsewhere (revocation, replacement) cancels both.

Registering before ``ready`` matters: an envelope stored before registration is already in
the mailbox when the client drains it after ``ready``; one stored afterwards is pushed (and
queued behind ``ready``, because the writer starts only after ``ready`` is sent).
"""

from __future__ import annotations

import json
import logging
import math
from typing import Annotated, Any

import anyio
from pydantic import Field, TypeAdapter, ValidationError
from starlette.types import Message
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from fixes_server.context import AppContext
from fixes_server.deps import Principal, authenticate_access_token
from fixes_server.errors import ApiError, error_response, rate_limited
from fixes_server.models.envelopes import MAX_ACK_IDS, EnvelopeId
from fixes_server.ratelimit import client_ip_key
from fixes_server.realtime import protocol
from fixes_server.realtime.connections import Connection
from fixes_server.services.envelopes import ack_envelopes, restore_gap, take_gap
from fixes_server.timeutil import utcnow

logger = logging.getLogger(__name__)

# Uvicorn enforces --ws-max-size 65536 bytes on incoming frames (§5.7); this keeps the same
# bound when the app runs under another server or the test client.
MAX_CLIENT_FRAME_CHARS = 65_536
MAX_TOKEN_CHARS = 4096

# Same rule as the REST ack body (AckRequest.ids).
_ACK_IDS: TypeAdapter[list[str]] = TypeAdapter(
    Annotated[list[EnvelopeId], Field(min_length=1, max_length=MAX_ACK_IDS)]
)


class _ClientProtocolError(Exception):
    """Raised by frame parsing: the client broke the protocol and the socket must close."""

    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


async def serve_socket(ctx: AppContext, websocket: WebSocket) -> None:
    try:
        await _serve(ctx, websocket)
    except WebSocketDisconnect:
        # A send found the client gone (e.g. it dropped between auth and ready); Starlette
        # has already marked the socket disconnected, so there is nothing to close.
        logger.debug("client went away during the WebSocket session")
    except Exception:
        logger.exception("WebSocket session failed")
        await _close(websocket, protocol.CLOSE_INTERNAL_ERROR, "internal error")


async def _serve(ctx: AppContext, websocket: WebSocket) -> None:
    # Numbered on arrival: if the client gives up on this socket and opens another, the other
    # one is newer even when this handshake finishes later (ConnectionManager.register).
    sequence = ctx.realtime.next_sequence()
    ip = client_ip_key(websocket)
    limits = ctx.rate_limits
    wait = limits.ws_connect.acquire(ip)
    if wait > 0:
        await _deny(websocket, rate_limited(max(1, math.ceil(wait))))
        return
    if not limits.ws_unauthenticated.try_enter(ip):
        # A slot frees up at the latest when the oldest pending socket hits the auth timeout.
        await _deny(
            websocket, rate_limited(max(1, math.ceil(ctx.settings.ws_auth_timeout_seconds)))
        )
        return
    try:
        principal = await _handshake(ctx, websocket)
    finally:
        limits.ws_unauthenticated.leave(ip)
    if principal is not None:
        await _serve_authenticated(ctx, websocket, principal, sequence)


async def _deny(websocket: WebSocket, error: ApiError) -> None:
    response = error_response(
        error.status_code, error.code, error.message, details=error.details, headers=error.headers
    )
    if "websocket.http.response" in (websocket.scope.get("extensions") or {}):
        await websocket.send_denial_response(response)
    else:
        # Servers without the denial-response extension can only refuse with a bare 403.
        await websocket.close(protocol.CLOSE_POLICY_VIOLATION)


async def _handshake(ctx: AppContext, websocket: WebSocket) -> Principal | None:
    """Accept and authenticate; returns ``None`` after closing (or losing) the socket."""
    await websocket.accept()
    message: Message | None = None
    with anyio.move_on_after(ctx.settings.ws_auth_timeout_seconds):
        message = await websocket.receive()
    if message is None:
        await _close(websocket, protocol.CLOSE_AUTH_TIMEOUT, "authentication timeout")
        return None
    if message["type"] == "websocket.disconnect":
        return None
    try:
        token = _auth_token(_parse_frame(message))
    except _ClientProtocolError as exc:
        await _close(websocket, exc.code, exc.reason)
        return None
    try:
        return await authenticate_access_token(ctx, token, touch_last_seen=False)
    except ApiError as exc:
        # unauthorized and device_revoked both map to 4401 (§6); the client tells them
        # apart by refreshing.
        await _close(websocket, protocol.CLOSE_UNAUTHORIZED, exc.code)
        return None


async def _serve_authenticated(
    ctx: AppContext, websocket: WebSocket, principal: Principal, sequence: int
) -> None:
    connection = Connection(principal.user_id, principal.device_id, sequence=sequence)
    ctx.realtime.register(connection)
    try:
        # Conditional on the device still being active: a revocation that ran after the
        # token check but before registration found no socket to close; this catches it,
        # because revocation sets revoked_at before it looks for sockets (§5.4).
        seen = await ctx.db.devices.update_one(
            {"_id": principal.device_id, "revoked_at": None},
            {"$set": {"last_seen_at": utcnow()}},
        )
        if seen.matched_count == 0:
            connection.close(protocol.CLOSE_UNAUTHORIZED, "device_revoked")
        elif not connection.closing and await _send_ready(ctx, websocket, connection):
            await _pump(ctx, websocket, connection)
    finally:
        ctx.realtime.unregister(connection)
    if connection.close_code is not None:
        await _close(websocket, connection.close_code, connection.close_reason)


async def _send_ready(ctx: AppContext, websocket: WebSocket, connection: Connection) -> bool:
    """Take the one-time gap flag and report it in ``ready``; False if ready was not sent.

    The flag is cleared before ready goes out, so a socket replaced or closed in between
    (or whose send fails) puts it back for the device's next socket or ``GET``.
    """
    gap = await take_gap(ctx, connection.device_id)
    try:
        if connection.closing:
            sent = False
        else:
            await websocket.send_text(protocol.ready(gap))
            sent = True
    except BaseException:
        if gap:
            with anyio.CancelScope(shield=True):
                await restore_gap(ctx, connection.device_id)
        raise
    if gap and not sent:
        await restore_gap(ctx, connection.device_id)
    return sent


async def _pump(ctx: AppContext, websocket: WebSocket, connection: Connection) -> None:
    async with anyio.create_task_group() as tasks:
        connection.attach(tasks.cancel_scope)
        tasks.start_soon(_write_loop, websocket, connection, tasks.cancel_scope)
        await _read_loop(ctx, websocket, connection)
        tasks.cancel_scope.cancel()


async def _write_loop(
    websocket: WebSocket, connection: Connection, cancel_scope: anyio.CancelScope
) -> None:
    try:
        while (text := await connection.next_message()) is not None:
            await websocket.send_text(text)
    except WebSocketDisconnect:
        logger.debug("client went away while receiving")
    except Exception:
        logger.exception("WebSocket writer failed")
        connection.close(protocol.CLOSE_INTERNAL_ERROR, "internal error")
    cancel_scope.cancel()


async def _read_loop(ctx: AppContext, websocket: WebSocket, connection: Connection) -> None:
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            await _handle_frame(ctx, connection, _parse_frame(message))
    except _ClientProtocolError as exc:
        connection.close(exc.code, exc.reason)
    except Exception:
        logger.exception("WebSocket reader failed")
        connection.close(protocol.CLOSE_INTERNAL_ERROR, "internal error")


async def _handle_frame(ctx: AppContext, connection: Connection, frame: dict[str, Any]) -> None:
    kind = frame.get("type")
    if kind == "ping":
        # Through the queue, so a pong never overtakes pushes queued before it.
        connection.send(protocol.PONG)
    elif kind == "ack":
        try:
            ids = _ACK_IDS.validate_python(frame.get("ids"))
        except ValidationError:
            raise _ClientProtocolError(
                protocol.CLOSE_POLICY_VIOLATION, f"ack needs 1-{MAX_ACK_IDS} envelope ids"
            ) from None
        await ack_envelopes(ctx, connection.device_id, ids)
    else:
        # Unknown types (and a repeated auth) are ignored so newer clients keep working.
        logger.debug("ignoring a WebSocket frame of an unknown type")


def _parse_frame(message: Message) -> dict[str, Any]:
    text = message.get("text")
    if text is None:
        raise _ClientProtocolError(
            protocol.CLOSE_UNSUPPORTED_DATA, "only text frames are supported"
        )
    if len(text) > MAX_CLIENT_FRAME_CHARS:
        raise _ClientProtocolError(protocol.CLOSE_MESSAGE_TOO_BIG, "frame too large")
    try:
        frame = json.loads(text)
    except (ValueError, RecursionError):
        # RecursionError: nesting deeper than the parser's limit (fits easily in 64 KiB).
        raise _ClientProtocolError(protocol.CLOSE_POLICY_VIOLATION, "frames must be JSON") from None
    if not isinstance(frame, dict):
        raise _ClientProtocolError(protocol.CLOSE_POLICY_VIOLATION, "frames must be JSON objects")
    return frame


def _auth_token(frame: dict[str, Any]) -> str:
    if frame.get("type") != "auth":
        raise _ClientProtocolError(protocol.CLOSE_POLICY_VIOLATION, "the first frame must be auth")
    token = frame.get("token")
    if not isinstance(token, str) or not 0 < len(token) <= MAX_TOKEN_CHARS:
        raise _ClientProtocolError(protocol.CLOSE_UNAUTHORIZED, "unauthorized")
    return token


async def _close(websocket: WebSocket, code: int, reason: str = "") -> None:
    """Close unless the socket is already gone; a vanished client is not an error."""
    if (
        websocket.application_state != WebSocketState.CONNECTED
        or websocket.client_state == WebSocketState.DISCONNECTED
    ):
        return
    try:
        await websocket.close(code, reason)
    except (WebSocketDisconnect, OSError):
        logger.debug("client went away before the close frame")
