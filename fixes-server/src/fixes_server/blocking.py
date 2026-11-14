"""Run CPU-bound or blocking calls (argon2, Pillow, boto3, file I/O) off the event loop.

Protocol §2: such work runs in worker threads behind one shared CapacityLimiter, so a burst
of logins or uploads cannot starve the event loop or spawn unbounded threads.
"""

from __future__ import annotations

from collections.abc import Callable

import anyio
import anyio.to_thread

BLOCKING_WORKERS = 4


def create_limiter() -> anyio.CapacityLimiter:
    return anyio.CapacityLimiter(BLOCKING_WORKERS)


async def run_blocking[T, *Ts](
    limiter: anyio.CapacityLimiter, func: Callable[[*Ts], T], *args: *Ts
) -> T:
    return await anyio.to_thread.run_sync(func, *args, limiter=limiter)
