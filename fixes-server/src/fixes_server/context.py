"""Process-wide services, built once in the lifespan and shared by every request."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import anyio
from pymongo import AsyncMongoClient

from fixes_server.blocking import create_limiter
from fixes_server.config import Settings
from fixes_server.db import Collections, create_client, ensure_indexes
from fixes_server.hooks import ChainedHooks, DeviceEventHooks
from fixes_server.ids import MonotonicObjectIds
from fixes_server.locks import KeyedLocks
from fixes_server.ratelimit import RateLimiters
from fixes_server.realtime.connections import ConnectionManager
from fixes_server.realtime.hooks import RealtimeHooks
from fixes_server.security.access_tokens import AccessTokenService
from fixes_server.security.passwords import PasswordService
from fixes_server.storage import AvatarStorage, create_storage

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class AppContext:
    settings: Settings
    mongo: AsyncMongoClient[dict[str, Any]]
    db: Collections
    blocking: anyio.CapacityLimiter
    passwords: PasswordService
    access_tokens: AccessTokenService
    storage: AvatarStorage
    rate_limits: RateLimiters
    hooks: DeviceEventHooks
    realtime: ConnectionManager
    mailbox_locks: KeyedLocks
    envelope_ids: MonotonicObjectIds

    async def aclose(self) -> None:
        try:
            await self.storage.aclose()
        finally:
            await self.mongo.close()


async def build_context(settings: Settings, observer: DeviceEventHooks | None = None) -> AppContext:
    """Connect, create indexes and prepare services; fails fast if MongoDB is unusable.

    ``observer`` is called after the real lifecycle hooks (tests use it to record events).
    """
    mongo = create_client(settings.mongodb_uri.get_secret_value())
    try:
        database = mongo[settings.mongodb_db]
        await ensure_indexes(database)
        limiter = create_limiter()
        passwords = PasswordService(limiter)
        await passwords.initialize()
        storage = await create_storage(settings, limiter)
    except BaseException:
        await mongo.close()
        raise
    logger.info(
        "fixes-server ready (database=%s, storage=%s)",
        settings.mongodb_db,
        settings.storage_backend,
    )
    collections = Collections.from_database(database)
    realtime = ConnectionManager()
    hooks: DeviceEventHooks = RealtimeHooks(collections.envelopes, realtime)
    if observer is not None:
        hooks = ChainedHooks(hooks, observer)
    return AppContext(
        settings=settings,
        mongo=mongo,
        db=collections,
        blocking=limiter,
        passwords=passwords,
        access_tokens=AccessTokenService(settings.jwt_secret.get_secret_value()),
        storage=storage,
        rate_limits=RateLimiters.from_settings(settings),
        hooks=hooks,
        realtime=realtime,
        mailbox_locks=KeyedLocks(),
        envelope_ids=MonotonicObjectIds(),
    )
