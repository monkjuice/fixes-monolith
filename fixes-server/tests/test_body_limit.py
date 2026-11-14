"""§5.7 request size limits, by Content-Length and by counting streamed bytes."""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Iterable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any

import anyio
import pytest
from starlette.testclient import TestClient
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from fixes_server import errors, middleware
from fixes_server.main import create_app
from fixes_server.middleware import (
    MAX_LARGE_BODY_REQUESTS_PER_USER,
    MAX_LARGE_JSON_BODIES_AT_ONCE,
    MIB,
    BodySizeLimitMiddleware,
)
from fixes_server.models.envelopes import MAX_UNKNOWN_KEYS
from fixes_server.services import envelopes as envelopes_service
from tests.conftest import MakeSettings
from tests.helpers import (
    Device,
    RecordingHooks,
    app_context,
    assert_error,
    fetch,
    linked_user,
    outgoing,
    random_password,
    send,
)

LARGE_BODY_ROUTES = [
    ("POST", "/v1/envelopes", (422, "validation_error")),
    ("PUT", "/v1/users/me/avatar", (400, "invalid_image")),
]


class BodyReadCounter:
    """Counts the request-body messages the app pulls from the server."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.reads = 0

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def counting_receive() -> Message:
            message = await receive()
            if message["type"] == "http.request":
                self.reads += 1
            return message

        await self.app(scope, counting_receive, send)


def _large_request(path: str) -> dict[str, Any]:
    """About 1 MiB for the route: a JSON envelope batch or a multipart avatar upload."""
    if path == "/v1/envelopes":
        body = b'{"envelopes":[' + b"{}," * (MIB // 3) + b"{}]}"
        return {"content": body, "headers": {"Content-Type": "application/json"}}
    return {"files": {"image": ("a.png", b"x" * MIB, "image/png")}, "headers": {}}


@pytest.mark.parametrize(("method", "path", "accepted"), LARGE_BODY_ROUTES)
def test_large_limits_need_a_valid_access_token_before_any_byte_is_read(
    make_settings: MakeSettings,
    hooks: RecordingHooks,
    method: str,
    path: str,
    accepted: tuple[int, str],
) -> None:
    """Without a valid token these routes answer 401 before reading (let alone parsing) the
    body: parsing a 9 MiB JSON body costs the server hundreds of MB."""
    counter = BodyReadCounter(create_app(make_settings(), hooks=hooks))
    with TestClient(counter) as client:
        _, device = linked_user(client)
        tokens = app_context(client).access_tokens
        user_id = tokens.verify(device.access_token).user_id
        expired = tokens.issue(user_id, device.id, datetime.now(UTC) - timedelta(hours=1))
        counter.reads = 0
        for authorization in (
            None,
            "Bearer not-a-jwt",
            f"Bearer {expired}",
            f"Basic {device.access_token}",
        ):
            request = _large_request(path)
            if authorization is not None:
                request["headers"]["Authorization"] = authorization
            response = client.request(method, path, **request)
            assert_error(response, 401, "unauthorized")
            assert response.headers["WWW-Authenticate"] == "Bearer"
            assert response.headers["Connection"] == "close"
        assert counter.reads == 0
        # A valid token gets the large limit: the body is read and the route answers.
        request = _large_request(path)
        request["headers"].update(device.headers)
        assert_error(client.request(method, path, **request), *accepted)
        assert counter.reads > 0


class HeldEnvelopeSends:
    """Holds ``POST /v1/envelopes`` of the given users inside the route, after the body was
    parsed, until :meth:`release`; records how many were inside at once."""

    def __init__(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        self.client = client
        self.user_ids: set[str] = set()
        self.held = 0
        self.most_held = 0
        self.changed = threading.Condition()

        async def new_event() -> anyio.Event:
            return anyio.Event()

        self._release = client.portal.call(new_event)
        real_send_envelopes = envelopes_service.send_envelopes

        async def held_send_envelopes(ctx: Any, principal: Any, *args: Any) -> Any:
            if principal.user_id not in self.user_ids:
                return await real_send_envelopes(ctx, principal, *args)
            with self.changed:
                self.held += 1
                self.most_held = max(self.most_held, self.held)
                self.changed.notify_all()
            try:
                await self._release.wait()
                return await real_send_envelopes(ctx, principal, *args)
            finally:
                with self.changed:
                    self.held -= 1

        monkeypatch.setattr(envelopes_service, "send_envelopes", held_send_envelopes)

    def wait_for(self, count: int, timeout: float) -> bool:
        with self.changed:
            return self.changed.wait_for(lambda: self.held >= count, timeout)

    def release(self) -> None:
        self.client.portal.call(self._release.set)


def test_large_body_requests_in_flight_are_capped_per_account(
    make_settings: MakeSettings, hooks: RecordingHooks, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A valid token is free to get (registration is open), so it alone bounds nothing: one
    account's requests in flight on the large-body routes are capped, and the next one is
    refused before any body byte is read. Other accounts are not affected."""
    counter = BodyReadCounter(create_app(make_settings(), hooks=hooks))
    with TestClient(counter) as client:
        account, device = linked_user(client)
        _, other = linked_user(client)
        held = HeldEnvelopeSends(client, monkeypatch)
        held.user_ids.add(account.id)
        cap = MAX_LARGE_BODY_REQUESTS_PER_USER
        with ThreadPoolExecutor(cap) as pool:
            pending = [pool.submit(send, client, device, [outgoing(device.id)]) for _ in range(cap)]
            try:
                assert held.wait_for(cap, 10)
                reads = counter.reads
                for method, path, _ in LARGE_BODY_ROUTES:
                    request = _large_request(path)
                    request["headers"].update(device.headers)
                    response = client.request(method, path, **request)
                    assert_error(response, 429, "rate_limited")
                    assert response.headers["Retry-After"] == "1"
                    assert response.headers["Connection"] == "close"
                assert counter.reads == reads
                assert send(client, other, [outgoing(other.id)]).status_code == 201
            finally:
                held.release()
            assert [future.result(10).status_code for future in pending] == [201] * cap
        assert held.most_held == cap
        assert send(client, device, [outgoing(device.id)]).status_code == 201


def test_large_json_bodies_are_handled_a_few_at_a_time(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """FastAPI parses a JSON body whole before the route runs, and a pathological 9 MiB batch
    becomes hundreds of MB of objects: only a few bodies over the default limit are parsed
    and handled at once, server-wide, whatever the number of accounts sending them. Small
    batches never wait for them."""
    senders = [linked_user(client)[1] for _ in range(MAX_LARGE_JSON_BODIES_AT_ONCE + 2)]
    _, small_sender = linked_user(client)
    held = HeldEnvelopeSends(client, monkeypatch)
    for sender in senders:
        held.user_ids.add(app_context(client).access_tokens.verify(sender.access_token).user_id)
    large_ciphertext = 48 * 1024  # two of them make a body over the 64 KiB default limit
    with ThreadPoolExecutor(len(senders)) as pool:
        pending = [
            pool.submit(send, client, sender, [outgoing(sender.id, size=large_ciphertext)] * 2)
            for sender in senders
        ]
        try:
            assert held.wait_for(MAX_LARGE_JSON_BODIES_AT_ONCE, 10)
            # The others are queued, not parsed: none of them reaches the route meanwhile.
            assert not held.wait_for(MAX_LARGE_JSON_BODIES_AT_ONCE + 1, 1.0)
            assert send(client, small_sender, [outgoing(small_sender.id)]).status_code == 201
        finally:
            held.release()
        assert [future.result(10).status_code for future in pending] == [201] * len(senders)
    assert held.most_held == MAX_LARGE_JSON_BODIES_AT_ONCE


def _large_batch(device: Device) -> bytes:
    """A valid batch over the 64 KiB default limit, addressed to ``device`` itself."""
    return json.dumps({"envelopes": [outgoing(device.id, size=48 * 1024)] * 2}).encode()


class DrivenBatch:
    """One ``POST /v1/envelopes`` run straight through the app with its own ASGI ``receive``
    and ``send``, like a raw client connection: with ``stall`` the client never reads the
    response (``send`` blocks until :meth:`release`), and with ``leave`` it goes away right
    after sending its body."""

    def __init__(
        self, client: TestClient, device: Device, *, stall: bool = False, leave: bool = False
    ) -> None:
        self.client = client
        self.device = device
        self.stall = stall
        self.leave = leave
        self.messages: list[Message] = []

        async def new_event() -> anyio.Event:
            return anyio.Event()

        self._release = client.portal.call(new_event)

    def start(self) -> Future[None]:
        """Start the request in the test client's event loop."""
        body = _large_batch(self.device)
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/v1/envelopes",
            "raw_path": b"/v1/envelopes",
            "root_path": "",
            "query_string": b"",
            "headers": [
                (b"host", b"testserver"),
                (b"authorization", f"Bearer {self.device.access_token}".encode()),
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
            "client": ("127.0.0.1", 50000),
            "server": ("testserver", 80),
        }
        body_sent = False

        async def receive() -> Message:
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            if not self.leave:
                await anyio.sleep_forever()
            return {"type": "http.disconnect"}

        async def send(message: Message) -> None:
            self.messages.append(message)
            if self.stall:
                await self._release.wait()

        async def run() -> None:
            await self.client.app(scope, receive, send)

        return self.client.portal.start_task_soon(run)

    def release(self) -> None:
        self.client.portal.call(self._release.set)


def test_a_response_the_client_does_not_read_gives_its_slot_back(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The server-wide slot of a large batch is held while its response is sent (the parsed
    body is alive until then), and a client that never reads, e.g. one that pipelines
    requests on a connection it does not read, would otherwise keep it forever."""
    caplog.set_level(logging.INFO, logger="fixes_server.middleware")
    monkeypatch.setattr(middleware, "SLOT_SEND_TIMEOUT_SECONDS", 0.2)
    batches = [
        DrivenBatch(client, linked_user(client)[1], stall=True)
        for _ in range(MAX_LARGE_JSON_BODIES_AT_ONCE)
    ]
    pending = [batch.start() for batch in batches]
    try:
        for future in pending:
            future.result(5)  # returns although the client never read the response
    finally:
        for batch in batches:
            batch.release()
    # The response was started, and the rest of it dropped once the client stalled.
    assert all([m["type"] for m in batch.messages] == ["http.response.start"] for batch in batches)
    abandoned = [r for r in caplog.records if "abandoned an envelope batch" in r.getMessage()]
    assert len(abandoned) == MAX_LARGE_JSON_BODIES_AT_ONCE
    # Both slots are free again.
    _, other = linked_user(client)
    assert send(client, other, [outgoing(other.id, size=48 * 1024)] * 2).status_code == 201


def test_a_large_batch_waits_for_a_slot_only_so_long(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A batch that cannot get a server-wide slot in time gets 429 (well before the app's own
    request timeout) instead of waiting indefinitely while its account's slot stays taken, and
    it is never handled later."""
    monkeypatch.setattr(middleware, "LARGE_JSON_WAIT_SECONDS", 0.2)
    holders = [linked_user(client)[1] for _ in range(MAX_LARGE_JSON_BODIES_AT_ONCE)]
    _, device = linked_user(client)
    held = HeldEnvelopeSends(client, monkeypatch)
    for holder in holders:
        held.user_ids.add(app_context(client).access_tokens.verify(holder.access_token).user_id)
    large = [outgoing(device.id, size=48 * 1024)] * 2
    cap = MAX_LARGE_BODY_REQUESTS_PER_USER
    with ThreadPoolExecutor(len(holders) + cap) as pool:
        holding = [
            pool.submit(send, client, holder, [outgoing(holder.id, size=48 * 1024)] * 2)
            for holder in holders
        ]
        try:
            assert held.wait_for(len(holders), 10)
            waiting = [pool.submit(send, client, device, large) for _ in range(cap)]
            for future in waiting:
                response = future.result(5)
                assert_error(response, 429, "rate_limited")
                assert response.headers["Retry-After"] == "1"
            # The account's slots were given back: a small batch needs no server-wide slot.
            assert send(client, device, [outgoing(device.id)]).status_code == 201
        finally:
            held.release()
        assert [future.result(10).status_code for future in holding] == [201] * len(holders)
    assert len(fetch(client, device)["envelopes"]) == 1


def test_a_large_batch_whose_client_left_while_it_waited_is_dropped(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A client that gives up while its batch waits for a server-wide slot (e.g. at its own
    request timeout, before retrying) frees its account's slot at once, and the abandoned
    batch is never handled."""
    holders = [linked_user(client)[1] for _ in range(MAX_LARGE_JSON_BODIES_AT_ONCE)]
    _, device = linked_user(client)
    held = HeldEnvelopeSends(client, monkeypatch)
    for holder in holders:
        held.user_ids.add(app_context(client).access_tokens.verify(holder.access_token).user_id)
    cap = MAX_LARGE_BODY_REQUESTS_PER_USER
    with ThreadPoolExecutor(len(holders)) as pool:
        holding = [
            pool.submit(send, client, holder, [outgoing(holder.id, size=48 * 1024)] * 2)
            for holder in holders
        ]
        try:
            assert held.wait_for(len(holders), 10)
            batches = [DrivenBatch(client, device, leave=True) for _ in range(cap)]
            for future in [batch.start() for batch in batches]:
                future.result(5)  # returns while both slots are still taken
            assert all(batch.messages == [] for batch in batches)
            # The account's slots were given back: a small batch needs no server-wide slot.
            assert send(client, device, [outgoing(device.id)]).status_code == 201
        finally:
            held.release()
        assert [future.result(10).status_code for future in holding] == [201] * len(holders)
    assert held.most_held == len(holders)
    assert len(fetch(client, device)["envelopes"]) == 1


class ErrorCounter:
    """Records how many validation errors reach the 422 handler, per response."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.counts: list[int] = []
        real_details = errors.validation_details

        def counting_details(found: Iterable[Any]) -> dict[str, Any]:
            listed = list(found)
            self.counts.append(len(listed))
            return real_details(listed)

        monkeypatch.setattr(errors, "validation_details", counting_details)


@pytest.mark.parametrize(
    "where", ["batch", "envelope"], ids=["unknown keys in the batch", "unknown keys in one"]
)
def test_a_batch_full_of_unknown_keys_is_refused_before_validation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, where: str
) -> None:
    """pydantic reports each unknown key, and FastAPI builds every report before the handler
    sees it: a 9 MiB batch of them costs about 1 GB and seconds of event-loop time, and was
    answered with a 422 of 34 MB. Such objects are refused whole, before validation."""
    _, device = linked_user(client)
    counter = ErrorCounter(monkeypatch)
    unknown = {f"k{index:06d}": 0 for index in range(200_000)}
    envelope = outgoing(device.id)
    batch = (
        {"envelopes": [envelope], **unknown}
        if where == "batch"
        else {"envelopes": [envelope, {**envelope, **unknown}]}
    )
    response = client.post(
        "/v1/envelopes", content=json.dumps(batch), headers=_json_headers(device)
    )
    assert len(response.request.content) > 2 * MIB
    details = assert_error(response, 422, "validation_error")
    assert set(details["fields"]) == {"body"}
    assert len(response.content) < 1024
    assert max(counter.counts, default=0) <= 1  # no error was built per unknown key
    # Valid batches, large ones included, are unaffected.
    assert send(client, device, [outgoing(device.id, size=48 * 1024)] * 2).status_code == 201


@pytest.mark.parametrize("where", ["batch", "envelope"])
def test_a_few_unknown_keys_in_a_batch_are_still_named(client: TestClient, where: str) -> None:
    """Objects are refused whole only beyond their model's fields plus ``MAX_UNKNOWN_KEYS``
    keys; up to that, each unknown key is named (here every field is present)."""
    _, device = linked_user(client)
    for count in (MAX_UNKNOWN_KEYS, MAX_UNKNOWN_KEYS + 1):
        unknown = {f"x{index}": 0 for index in range(count)}
        envelope = outgoing(device.id)
        if where == "batch":
            batch = {"envelopes": [envelope], "complete_for_user_ids": [], **unknown}
            prefix = ""
        else:
            batch, prefix = {"envelopes": [{**envelope, **unknown}]}, "envelopes.0."
        response = client.post(
            "/v1/envelopes", content=json.dumps(batch), headers=_json_headers(device)
        )
        fields = set(assert_error(response, 422, "validation_error")["fields"])
        if count == MAX_UNKNOWN_KEYS:
            assert fields == {prefix + key for key in unknown}
        else:
            assert fields == {"body"}


def _json_headers(device: Device) -> dict[str, str]:
    return {"Content-Type": "application/json", **device.headers}


def test_authenticated_envelope_body_limit_is_exact(client: TestClient) -> None:
    _, device = linked_user(client)
    headers = {"Content-Type": "application/json", **device.headers}
    at_limit = b"{" + b" " * (9 * MIB - 2) + b"}"
    assert_error(
        client.post("/v1/envelopes", content=at_limit, headers=headers), 422, "validation_error"
    )
    over = at_limit + b" "
    details = assert_error(
        client.post("/v1/envelopes", content=over, headers=headers), 413, "payload_too_large"
    )
    assert details["limit"] == 9 * MIB


def test_route_limits() -> None:
    middleware = BodySizeLimitMiddleware(app=None)  # type: ignore[arg-type]
    assert middleware.limit_for("POST", "/v1/envelopes") == 9 * MIB
    assert middleware.limit_for("PUT", "/v1/users/me/avatar") == 5 * MIB + MIB // 2
    assert middleware.limit_for("POST", "/v1/auth/login") == 64 * 1024
    assert middleware.limit_for("GET", "/v1/envelopes") == 64 * 1024


def test_declared_length_over_limit_is_413(client: TestClient) -> None:
    body = b"{" + b" " * (64 * 1024) + b"}"
    response = client.post(
        "/v1/auth/register", content=body, headers={"Content-Type": "application/json"}
    )
    details = assert_error(response, 413, "payload_too_large")
    assert details["limit"] == 64 * 1024


def test_streamed_body_over_limit_is_413(client: TestClient) -> None:
    def chunks() -> Iterator[bytes]:
        yield b'{"username": "'
        for _ in range(20):
            yield b"a" * 4096
        yield b'"}'

    # A generator body is sent without Content-Length, so only counting can catch it.
    response = client.post(
        "/v1/auth/register", content=chunks(), headers={"Content-Type": "application/json"}
    )
    assert "content-length" not in response.request.headers
    assert_error(response, 413, "payload_too_large")


def test_body_at_limit_is_accepted(client: TestClient) -> None:
    padding = 64 * 1024 - len('{"username":"abc_def","password":""}')
    body = '{"username":"abc_def","password":"' + "p" * padding + '"}'
    assert len(body.encode()) == 64 * 1024
    response = client.post(
        "/v1/auth/register", content=body, headers={"Content-Type": "application/json"}
    )
    # Passed the size limit and reached validation (the password is too long).
    assert_error(response, 422, "validation_error")
    ok = client.post(
        "/v1/auth/register", json={"username": "abc_def", "password": random_password()}
    )
    assert ok.status_code == 201


def test_avatar_route_allows_more_but_not_unbounded(client: TestClient) -> None:
    _, device = linked_user(client)
    too_big = b"\0" * (6 * MIB)
    response = client.put(
        "/v1/users/me/avatar",
        files={"image": ("a.png", too_big, "image/png")},
        headers=device.headers,
    )
    assert_error(response, 413, "payload_too_large")
