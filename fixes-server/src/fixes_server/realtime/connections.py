"""Authenticated sockets and the in-memory fan-out to them (protocol §6)."""

from __future__ import annotations

import itertools
import logging
from collections import deque
from collections.abc import Collection, Iterable

import anyio

from fixes_server.realtime.protocol import CLOSE_REPLACED, CLOSE_TRY_AGAIN_LATER

logger = logging.getLogger(__name__)

# Upper bound on text queued for one socket. Pushes are an optimisation (envelopes stay in
# the mailbox until acked), so a client that falls this far behind is disconnected and
# catches up with GET /v1/envelopes after reconnecting, instead of growing server memory.
MAX_QUEUED_CHARS = 16 * 1024 * 1024


class Connection:
    """The outbound side of one authenticated socket.

    Producers (REST handlers, revocation, other sockets) never wait on the network: they
    append to a bounded queue that the socket's own writer drains. Closing is a request that
    cancels the socket's tasks; the session then sends the close frame with ``close_code``.
    """

    def __init__(
        self,
        user_id: str,
        device_id: str,
        *,
        sequence: int = 0,
        max_queued_chars: int = MAX_QUEUED_CHARS,
    ) -> None:
        self.user_id = user_id
        self.device_id = device_id
        # When the socket was opened, from ConnectionManager.next_sequence(): of two sockets
        # of one device, the one opened later is the newer one, whichever authenticates first.
        self.sequence = sequence
        self.close_code: int | None = None
        self.close_reason = ""
        self._max_queued_chars = max_queued_chars
        self._queue: deque[str] = deque()
        self._queued_chars = 0
        self._wakeup = anyio.Event()
        self._cancel_scope: anyio.CancelScope | None = None

    @property
    def closing(self) -> bool:
        return self.close_code is not None

    def send(self, text: str) -> None:
        """Queue a message without waiting; overflowing the queue closes the socket (1013)."""
        if self.close_code is not None:
            return
        if self._queued_chars + len(text) > self._max_queued_chars:
            logger.info("closing a socket that is not keeping up with its messages")
            self.close(CLOSE_TRY_AGAIN_LATER, "too many undelivered messages")
            return
        self._queue.append(text)
        self._queued_chars += len(text)
        self._wakeup.set()

    def close(self, code: int, reason: str = "") -> None:
        """Ask the socket to close. The first request wins; queued messages are dropped."""
        if self.close_code is not None:
            return
        self.close_code = code
        self.close_reason = reason
        self._queue.clear()
        self._queued_chars = 0
        self._wakeup.set()
        if self._cancel_scope is not None:
            self._cancel_scope.cancel()

    def attach(self, cancel_scope: anyio.CancelScope) -> None:
        """Bind the scope running this socket's tasks, so :meth:`close` can stop them."""
        self._cancel_scope = cancel_scope
        if self.close_code is not None:
            cancel_scope.cancel()

    async def next_message(self) -> str | None:
        """The next queued message, waiting if needed; ``None`` once closing was requested."""
        while self.close_code is None:
            if self._queue:
                text = self._queue.popleft()
                self._queued_chars -= len(text)
                return text
            # anyio events cannot be reset; a fresh one per wait is the idiom. No await
            # happens between the emptiness check and this, so no wakeup can be missed.
            self._wakeup = anyio.Event()
            await self._wakeup.wait()
        return None


class ConnectionManager:
    """At most one live socket per device (§6.5), indexed by device and by user."""

    def __init__(self) -> None:
        self._by_device: dict[str, Connection] = {}
        self._devices_by_user: dict[str, set[str]] = {}
        self._sequence = itertools.count(1)

    def __len__(self) -> int:
        return len(self._by_device)

    def next_sequence(self) -> int:
        """A number for a socket being opened; later sockets get larger numbers."""
        return next(self._sequence)

    def get(self, device_id: str) -> Connection | None:
        return self._by_device.get(device_id)

    def register(self, connection: Connection) -> None:
        """Make ``connection`` the device's socket, closing the older of the two with 4409.

        Usually that is the registered one. But when a client gave up on a slow handshake and
        opened another socket, the abandoned one may finish authenticating last; it must not
        take the device over from the socket the client is actually using (§6).
        """
        previous = self._by_device.get(connection.device_id)
        if (
            previous is not None
            and previous is not connection
            and previous.sequence > connection.sequence
        ):
            connection.close(CLOSE_REPLACED, "replaced by a newer connection")
            return
        self._by_device[connection.device_id] = connection
        self._devices_by_user.setdefault(connection.user_id, set()).add(connection.device_id)
        if previous is not None and previous is not connection:
            previous.close(CLOSE_REPLACED, "replaced by a newer connection")

    def unregister(self, connection: Connection) -> None:
        # A replaced socket must not remove its successor's entry.
        if self._by_device.get(connection.device_id) is not connection:
            return
        del self._by_device[connection.device_id]
        devices = self._devices_by_user.get(connection.user_id)
        if devices is not None:
            devices.discard(connection.device_id)
            if not devices:
                del self._devices_by_user[connection.user_id]

    def send_to_device(self, device_id: str, text: str) -> bool:
        connection = self._by_device.get(device_id)
        if connection is None:
            return False
        connection.send(text)
        return True

    def send_to_user(self, user_id: str, text: str, *, exclude: Collection[str] = ()) -> int:
        sent = 0
        for device_id in sorted(self._devices_by_user.get(user_id, ())):
            if device_id not in exclude and self.send_to_device(device_id, text):
                sent += 1
        return sent

    def close_devices(self, device_ids: Iterable[str], code: int, reason: str = "") -> None:
        for device_id in device_ids:
            connection = self._by_device.get(device_id)
            if connection is not None:
                connection.close(code, reason)

    def close_all(self, code: int, reason: str = "") -> None:
        self.close_devices(list(self._by_device), code, reason)
