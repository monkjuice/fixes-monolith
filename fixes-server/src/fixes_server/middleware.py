"""Pure ASGI guards: the request-body size limit (protocol §5.7), concurrency caps on the
routes that move large bodies, and paced sending of envelope pages."""

from __future__ import annotations

import logging
from collections.abc import Iterator, Mapping
from enum import Enum, auto

import anyio
from fastapi.security.utils import get_authorization_scheme_param
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from fixes_server.errors import ApiError, error_response, rate_limited, unauthorized
from fixes_server.ratelimit import KeyedConcurrencyLimiter
from fixes_server.security.access_tokens import AccessClaims, InvalidAccessTokenError

logger = logging.getLogger(__name__)

MIB = 1024 * 1024
DEFAULT_BODY_LIMIT = 64 * 1024
# Both routes require an access token. Their larger limits are granted only to requests whose
# token verifies (an HMAC check, no database), before any body byte is read: FastAPI parses
# the body before the route authenticates, and parsing 9 MiB of JSON costs hundreds of MB.
ROUTE_BODY_LIMITS: Mapping[tuple[str, str], int] = {
    ("POST", "/v1/envelopes"): 9 * MIB,
    ("PUT", "/v1/users/me/avatar"): 5 * MIB + MIB // 2,
}
# Registration is free, so a valid token alone bounds nothing. Requests per account in flight
# on those routes, checked before any body byte is read (the app sends one batch at a time per
# device); more get 429.
MAX_LARGE_BODY_REQUESTS_PER_USER = 4
# FastAPI parses a JSON body whole, on the event loop, before the route (and its per-user rate
# limit) runs, and a pathological 9 MiB batch such as {"envelopes":[{},{},...]} becomes about
# 250 MB of Python objects that live until the request ends. So on these routes a body over
# the default limit is read here first and handed on only a few at a time, server-wide.
JSON_BODY_ROUTES = frozenset({("POST", "/v1/envelopes")})
MAX_LARGE_JSON_BODIES_AT_ONCE = 2
# Neither the wait for a slot nor the response sent while holding one may last indefinitely:
# a request still waiting after LARGE_JSON_WAIT_SECONDS (well within the app's 30 s request
# timeout) gets 429, one whose client went away meanwhile is dropped unprocessed, and a
# response the client leaves unread for SLOT_SEND_TIMEOUT_SECONDS is abandoned.
LARGE_JSON_WAIT_SECONDS = 10.0
SLOT_SEND_TIMEOUT_SECONDS = 5.0

# A GET /v1/envelopes page is rendered whole (up to about 5.6 MB of JSON, §5.3).
ENVELOPE_PAGE_ROUTE = ("GET", "/v1/envelopes")
MAX_PAGES_PER_DEVICE = 2  # the app drains one page at a time per device
PAGE_CHUNK_BYTES = 64 * 1024
PAGE_SEND_TIMEOUT_SECONDS = 30.0


class _Slot(Enum):
    ACQUIRED = auto()
    BUSY = auto()
    CLIENT_GONE = auto()


class PayloadTooLargeError(ApiError):
    def __init__(self, limit: int) -> None:
        super().__init__(
            413, "payload_too_large", "Request body is too large", details={"limit": limit}
        )


class BodySizeLimitMiddleware:
    """Reject bodies over the route's limit, by ``Content-Length`` and by counting streamed bytes.

    The declared length is checked first so honest oversized uploads are refused before any
    byte is read; counting catches chunked bodies and clients that lie about their length.
    The routes with larger limits are also capped per account and, for JSON, server-wide
    (see ``MAX_LARGE_BODY_REQUESTS_PER_USER`` and ``MAX_LARGE_JSON_BODIES_AT_ONCE``).
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        default_limit: int = DEFAULT_BODY_LIMIT,
        route_limits: Mapping[tuple[str, str], int] = ROUTE_BODY_LIMITS,
    ) -> None:
        self.app = app
        self.default_limit = default_limit
        self.route_limits = dict(route_limits)
        self.large_requests = KeyedConcurrencyLimiter(MAX_LARGE_BODY_REQUESTS_PER_USER)
        self.large_json_bodies = anyio.Semaphore(MAX_LARGE_JSON_BODIES_AT_ONCE)

    def limit_for(self, method: str, path: str) -> int:
        return self.route_limits.get(_route(method, path), self.default_limit)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.limit_for(scope["method"], scope["path"])
        claims: AccessClaims | None = None
        if limit > self.default_limit:
            claims = verified_access_claims(scope)
            if claims is None:
                # 401 rather than 413, so the app's refresh-and-retry path still works.
                await _answer_and_close(scope, receive, send, unauthorized())
                return
        declared = _content_length(scope)
        if declared is not None and declared > limit:
            await self._reject(scope, receive, send, limit)
            return
        if claims is None:
            await self._stream(scope, receive, send, limit)
            return

        if not self.large_requests.try_enter(claims.user_id):
            await _answer_and_close(scope, receive, send, rate_limited(1))
            return
        try:
            if _route(scope["method"], scope["path"]) in JSON_BODY_ROUTES:
                await self._buffer(scope, receive, send, limit)
            else:
                await self._stream(scope, receive, send, limit)
        finally:
            self.large_requests.leave(claims.user_id)

    async def _stream(self, scope: Scope, receive: Receive, send: Send, limit: int) -> None:
        """Pass the body through to the app as it arrives, counting it."""
        received = 0
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    # Raised inside the app's own body read; the ApiError handler turns it into
                    # the 413 body, and the except below covers apps that let it escape.
                    raise PayloadTooLargeError(limit)
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except PayloadTooLargeError:
            if response_started:
                raise
            await self._reject(scope, receive, send, limit)

    async def _buffer(self, scope: Scope, receive: Receive, send: Send, limit: int) -> None:
        """Read the whole body, then hand it to the app. A body over the default limit first
        waits for a server-wide slot, held until the app (and so its parsed body) is done;
        see ``LARGE_JSON_WAIT_SECONDS`` for how long either may last."""
        chunks: list[bytes] = []
        received = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                return  # the client went away before sending the whole body
            chunk: bytes = message.get("body", b"")
            received += len(chunk)
            if received > limit:
                await self._reject(scope, receive, send, limit)
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        chunks.clear()
        replayed = False

        async def replay_receive() -> Message:
            nonlocal replayed
            if replayed:
                return await receive()  # e.g. a wait for http.disconnect
            replayed = True
            return {"type": "http.request", "body": body, "more_body": False}

        if received <= self.default_limit:
            await self.app(scope, replay_receive, send)
            return
        slot = await self._wait_for_large_json_slot(receive)
        if slot is _Slot.CLIENT_GONE:
            return  # the batch is never handled
        if slot is _Slot.BUSY:
            body = b""  # not kept while the answer waits for the client to read it
            await _error_response(rate_limited(1))(scope, receive, send)
            return
        stalled = False

        async def bounded_send(message: Message) -> None:
            nonlocal stalled
            if stalled:
                return
            with anyio.move_on_after(SLOT_SEND_TIMEOUT_SECONDS) as deadline:
                await send(message)
            stalled = deadline.cancelled_caught

        try:
            await self.app(scope, replay_receive, bounded_send)
        finally:
            self.large_json_bodies.release()
        if stalled:
            logger.info(
                "abandoned an envelope batch response: the client read nothing for %d s",
                SLOT_SEND_TIMEOUT_SECONDS,
            )

    async def _wait_for_large_json_slot(self, receive: Receive) -> _Slot:
        """Wait at most ``LARGE_JSON_WAIT_SECONDS`` for a server-wide slot, and only while the
        client is still there (the whole body has been read, so ``receive`` now returns only
        ``http.disconnect``)."""
        acquired = client_gone = False
        async with anyio.create_task_group() as waiting:

            async def watch_for_disconnect() -> None:
                nonlocal client_gone
                if (await receive())["type"] == "http.disconnect":
                    client_gone = True
                    waiting.cancel_scope.cancel()

            waiting.start_soon(watch_for_disconnect)
            with anyio.move_on_after(LARGE_JSON_WAIT_SECONDS):
                await self.large_json_bodies.acquire()
                acquired = True
            waiting.cancel_scope.cancel()
        if client_gone:
            if acquired:  # both happened in the same event-loop turn
                self.large_json_bodies.release()
            return _Slot.CLIENT_GONE
        return _Slot.ACQUIRED if acquired else _Slot.BUSY

    @staticmethod
    async def _reject(scope: Scope, receive: Receive, send: Send, limit: int) -> None:
        await _answer_and_close(scope, receive, send, PayloadTooLargeError(limit))


class EnvelopePageMiddleware:
    """Sends ``GET /v1/envelopes`` pages in pieces, at most ``MAX_PAGES_PER_DEVICE`` per device.

    Uvicorn hands a single body message to the transport whole, and whatever the client does
    not read stays in server memory for as long as the connection lives. Sent in
    ``PAGE_CHUNK_BYTES`` pieces, each send waits for the client to read the previous ones, so
    this call (and the device's slot) lasts until the page is delivered; more pages for the
    device meanwhile get 429. A client that reads nothing for ``PAGE_SEND_TIMEOUT_SECONDS`` is
    abandoned: the rest of the page is dropped and Uvicorn closes the connection.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.pages = KeyedConcurrencyLimiter(MAX_PAGES_PER_DEVICE)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or _route(scope["method"], scope["path"]) != ENVELOPE_PAGE_ROUTE:
            await self.app(scope, receive, send)
            return
        claims = verified_access_claims(scope)
        if claims is None:
            await self.app(scope, receive, send)  # the route answers 401
            return
        if not self.pages.try_enter(claims.device_id):
            await _error_response(rate_limited(1))(scope, receive, send)
            return
        stalled = False

        async def paced_send(message: Message) -> None:
            nonlocal stalled
            for piece in _pieces(message):
                if stalled:
                    return
                with anyio.move_on_after(PAGE_SEND_TIMEOUT_SECONDS) as deadline:
                    await send(piece)
                stalled = deadline.cancelled_caught

        try:
            await self.app(scope, receive, paced_send)
        finally:
            self.pages.leave(claims.device_id)
        if stalled:
            logger.info(
                "abandoned an envelope page: the client read nothing for %d s",
                PAGE_SEND_TIMEOUT_SECONDS,
            )


def _pieces(message: Message) -> Iterator[Message]:
    if message["type"] != "http.response.body":
        yield message
        return
    body: bytes = message.get("body", b"")
    more_body = bool(message.get("more_body", False))
    for start in range(0, max(len(body), 1), PAGE_CHUNK_BYTES):
        end = start + PAGE_CHUNK_BYTES
        yield {
            "type": "http.response.body",
            "body": body[start:end],
            "more_body": more_body or end < len(body),
        }


def _error_response(error: ApiError) -> JSONResponse:
    return error_response(
        error.status_code, error.code, error.message, details=error.details, headers=error.headers
    )


async def _answer_and_close(scope: Scope, receive: Receive, send: Send, error: ApiError) -> None:
    """Send ``error`` without reading the request body."""
    response = _error_response(error)
    # Ask the client to close: the unread remainder of the body must not be parsed as the
    # next request on this connection.
    response.headers["Connection"] = "close"
    await response(scope, receive, send)


def _route(method: str, path: str) -> tuple[str, str]:
    return method.upper(), path.rstrip("/") or "/"


def verified_access_claims(scope: Scope) -> AccessClaims | None:
    """The claims of the request's bearer access token if it verifies (an HMAC check, no
    database); the route itself still authenticates it fully (device and revocation checks)."""
    ctx = getattr(getattr(scope.get("app"), "state", None), "ctx", None)
    if ctx is None:
        return None
    authorization = None
    for name, value in scope.get("headers", ()):
        if name == b"authorization":
            authorization = value.decode("latin-1")
            break
    scheme, token = get_authorization_scheme_param(authorization)
    if scheme.lower() != "bearer" or not token:
        return None
    try:
        claims: AccessClaims = ctx.access_tokens.verify(token)
    except InvalidAccessTokenError:
        return None
    return claims


def _content_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", ()):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                # The HTTP server rejects malformed lengths itself; counting still applies.
                return None
    return None
