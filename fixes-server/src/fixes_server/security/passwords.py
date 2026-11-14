"""argon2id password hashing (protocol §5.5), always executed in the worker pool."""

from __future__ import annotations

import logging
import secrets

import anyio
from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from fixes_server.blocking import run_blocking

logger = logging.getLogger(__name__)

ARGON2_TIME_COST = 3
ARGON2_MEMORY_COST_KIB = 65536
ARGON2_PARALLELISM = 1


def default_hasher() -> PasswordHasher:
    return PasswordHasher(
        time_cost=ARGON2_TIME_COST,
        memory_cost=ARGON2_MEMORY_COST_KIB,
        parallelism=ARGON2_PARALLELISM,
        type=Type.ID,
    )


class PasswordService:
    def __init__(
        self, limiter: anyio.CapacityLimiter, hasher: PasswordHasher | None = None
    ) -> None:
        self._limiter = limiter
        self._hasher = hasher or default_hasher()
        self._dummy_hash: str | None = None

    async def initialize(self) -> None:
        # A real hash of a random password with the live parameters: verifying against it for
        # unknown usernames costs exactly as much as a real verification.
        self._dummy_hash = await self.hash(secrets.token_urlsafe(32))

    async def hash(self, password: str) -> str:
        return await run_blocking(self._limiter, self._hasher.hash, password)

    async def verify(self, password_hash: str | None, password: str) -> bool:
        """Check a password; ``password_hash=None`` (unknown user) runs a dummy verification."""
        if password_hash is None:
            if self._dummy_hash is None:
                raise RuntimeError("PasswordService.initialize() was not awaited")
            await run_blocking(self._limiter, self._verify_sync, self._dummy_hash, password)
            return False
        return await run_blocking(self._limiter, self._verify_sync, password_hash, password)

    def needs_rehash(self, password_hash: str) -> bool:
        return self._hasher.check_needs_rehash(password_hash)

    def _verify_sync(self, password_hash: str, password: str) -> bool:
        try:
            return self._hasher.verify(password_hash, password)
        except VerifyMismatchError:
            return False
        except (InvalidHashError, VerificationError):
            # A corrupt stored hash must not lock the server up or leak details; treat it as
            # a failed login but make it visible to operators.
            logger.warning("stored password hash could not be verified (corrupt or unsupported)")
            return False
