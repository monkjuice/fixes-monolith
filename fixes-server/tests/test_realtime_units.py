"""Unit tests of the in-memory pieces: keyed locks, envelope ids and socket fan-out."""

from __future__ import annotations

import anyio
import pytest
from bson import ObjectId

from fixes_server.ids import MonotonicObjectIds
from fixes_server.locks import KeyedLocks
from fixes_server.realtime.connections import Connection, ConnectionManager
from fixes_server.realtime.protocol import CLOSE_REPLACED, CLOSE_TRY_AGAIN_LATER


def test_object_ids_strictly_increase() -> None:
    ids = MonotonicObjectIds()
    generated = [ids.next() for _ in range(1000)]
    assert generated == sorted(set(generated))


def test_object_ids_survive_a_clock_step_back() -> None:
    ids = MonotonicObjectIds()
    # As if the previous id had been made far in the future (clock stepped back since).
    future = ObjectId("ffffffff" + "00" * 8)
    ids._last = future
    following = [ids.next() for _ in range(3)]
    assert following[0] > future
    assert following == sorted(set(following))


def test_keyed_locks_serialise_overlapping_batches() -> None:
    locks = KeyedLocks()
    order: list[str] = []

    async def batch(name: str, keys: list[str], hold: float) -> None:
        async with locks.hold(keys):
            order.append(f"{name}+")
            await anyio.sleep(hold)
            order.append(f"{name}-")

    async def main() -> None:
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(batch, "a", ["d1", "d2"], 0.05)
            await anyio.sleep(0.01)
            # Overlaps on d2 (listed in the other order: still no deadlock) and must wait.
            tasks.start_soon(batch, "b", ["d3", "d2"], 0.0)
            # Disjoint keys run concurrently.
            tasks.start_soon(batch, "c", ["d4"], 0.0)
        assert len(locks) == 0  # nothing is kept once released

    anyio.run(main)
    assert order.index("a-") < order.index("b+")
    assert order.index("c-") < order.index("a-")


def test_keyed_locks_forget_cancelled_waiters() -> None:
    locks = KeyedLocks()

    async def main() -> None:
        held = anyio.Event()
        release = anyio.Event()

        async def holder() -> None:
            async with locks.hold(["k"]):
                held.set()
                await release.wait()

        async with anyio.create_task_group() as tasks:
            tasks.start_soon(holder)
            await held.wait()
            with anyio.move_on_after(0.05) as waiting:
                async with locks.hold(["k"]):
                    pytest.fail("the lock is held by another task")
            assert waiting.cancelled_caught
            assert locks._entries["k"].users == 1  # the cancelled waiter left no reference
            release.set()
        assert len(locks) == 0

    anyio.run(main)


def test_connection_queue_and_close() -> None:
    async def main() -> None:
        connection = Connection("u", "d", max_queued_chars=10)
        connection.send("12345")
        connection.send("678")
        assert await connection.next_message() == "12345"
        connection.send("abcdefg")  # 3 + 7 = 10 fits exactly
        connection.send("x")  # overflow: the slow socket is dropped, not buffered further
        assert connection.close_code == CLOSE_TRY_AGAIN_LATER
        assert await connection.next_message() is None
        connection.send("ignored")
        assert await connection.next_message() is None

    anyio.run(main)


def test_close_cancels_the_attached_scope() -> None:
    async def main() -> None:
        connection = Connection("u", "d")
        with anyio.CancelScope() as scope:
            connection.attach(scope)
            connection.close(4401, "revoked")
            connection.close(4409, "later requests do not override the first")
            await anyio.sleep(1)
        assert scope.cancelled_caught
        assert (connection.close_code, connection.close_reason) == (4401, "revoked")

    anyio.run(main)


def test_manager_replaces_and_fans_out() -> None:
    async def main() -> None:
        manager = ConnectionManager()
        old = Connection("u1", "d1")
        manager.register(old)
        new = Connection("u1", "d1")
        manager.register(new)
        assert old.close_code == CLOSE_REPLACED
        manager.unregister(old)  # the replaced socket finishing must not drop its successor
        assert manager.get("d1") is new

        other = Connection("u1", "d2")
        stranger = Connection("u2", "d3")
        manager.register(other)
        manager.register(stranger)
        assert manager.send_to_user("u1", "hello", exclude={"d2"}) == 1
        assert await new.next_message() == "hello"
        assert manager.send_to_device("missing", "x") is False

        manager.close_all(1012)
        assert {new.close_code, other.close_code, stranger.close_code} == {1012}
        for connection in (new, other, stranger):
            manager.unregister(connection)
        assert len(manager) == 0

    anyio.run(main)


def test_manager_keeps_the_most_recently_opened_socket() -> None:
    """Sockets are numbered when they are opened; one that finishes its handshake after a
    newer socket of the same device is the one closed with 4409."""

    async def main() -> None:
        manager = ConnectionManager()
        older = Connection("u1", "d1", sequence=manager.next_sequence())
        newer = Connection("u1", "d1", sequence=manager.next_sequence())
        manager.register(newer)
        manager.register(older)
        assert older.close_code == CLOSE_REPLACED
        assert newer.close_code is None
        assert manager.get("d1") is newer
        manager.unregister(older)
        assert manager.get("d1") is newer

    anyio.run(main)
