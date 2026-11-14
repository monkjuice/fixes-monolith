"""In-process keyed locks (the server runs as a single process, protocol §2)."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import anyio


@dataclass(slots=True)
class _Entry:
    lock: anyio.Lock = field(default_factory=anyio.Lock)
    users: int = 0


class KeyedLocks:
    """One lock per key, created on demand and forgotten once nobody holds or awaits it.

    Used to make the mailbox caps exact: counting a device's pending envelopes and inserting
    new ones must not interleave with another batch for the same device. MongoDB transactions
    would do this across processes, but the spec deliberately runs without them (§1, §2).
    """

    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}

    @asynccontextmanager
    async def hold(self, keys: Iterable[str]) -> AsyncIterator[None]:
        # One global order (sorted) means two batches with overlapping keys cannot deadlock.
        acquired: list[str] = []
        try:
            for key in sorted(set(keys)):
                await self._acquire(key)
                acquired.append(key)
            yield
        finally:
            for key in reversed(acquired):
                self._release(key)

    def __len__(self) -> int:
        return len(self._entries)

    async def _acquire(self, key: str) -> None:
        entry = self._entries.get(key)
        if entry is None:
            entry = self._entries[key] = _Entry()
        entry.users += 1
        try:
            await entry.lock.acquire()
        except BaseException:
            # Cancelled while waiting: drop the reference without having taken the lock.
            self._forget(key, entry)
            raise

    def _release(self, key: str) -> None:
        entry = self._entries[key]
        entry.lock.release()
        self._forget(key, entry)

    def _forget(self, key: str, entry: _Entry) -> None:
        entry.users -= 1
        if entry.users == 0:
            del self._entries[key]
