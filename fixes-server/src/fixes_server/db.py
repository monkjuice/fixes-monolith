"""MongoDB connection, typed collections and idempotent index setup (protocol §11)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, cast

from pymongo import ASCENDING, AsyncMongoClient, IndexModel
from pymongo.asynchronous.collection import AsyncCollection
from pymongo.asynchronous.database import AsyncDatabase

from fixes_server.documents import (
    DeviceDoc,
    EnvelopeDoc,
    FriendRequestDoc,
    FriendshipDoc,
    RefreshTokenDoc,
    UserDoc,
)

logger = logging.getLogger(__name__)

SERVER_SELECTION_TIMEOUT_MS = 10_000


@dataclass(frozen=True, slots=True)
class Collections:
    users: AsyncCollection[UserDoc]
    devices: AsyncCollection[DeviceDoc]
    refresh_tokens: AsyncCollection[RefreshTokenDoc]
    friend_requests: AsyncCollection[FriendRequestDoc]
    friendships: AsyncCollection[FriendshipDoc]
    envelopes: AsyncCollection[EnvelopeDoc]

    @classmethod
    def from_database(cls, database: AsyncDatabase[dict[str, Any]]) -> Collections:
        return cls(
            users=cast("AsyncCollection[UserDoc]", database["users"]),
            devices=cast("AsyncCollection[DeviceDoc]", database["devices"]),
            refresh_tokens=cast("AsyncCollection[RefreshTokenDoc]", database["refresh_tokens"]),
            friend_requests=cast("AsyncCollection[FriendRequestDoc]", database["friend_requests"]),
            friendships=cast("AsyncCollection[FriendshipDoc]", database["friendships"]),
            envelopes=cast("AsyncCollection[EnvelopeDoc]", database["envelopes"]),
        )


def create_client(uri: str) -> AsyncMongoClient[dict[str, Any]]:
    # tz_aware: every datetime read back is UTC-aware, so comparisons with utcnow() are safe.
    return AsyncMongoClient(
        uri,
        tz_aware=True,
        serverSelectionTimeoutMS=SERVER_SELECTION_TIMEOUT_MS,
        appname="fixes-server",
    )


_INDEXES: dict[str, list[IndexModel]] = {
    "users": [IndexModel([("username_lower", ASCENDING)], unique=True)],
    "devices": [
        IndexModel([("user_id", ASCENDING)]),
        IndexModel([("public_key", ASCENDING)], unique=True),
        IndexModel([("last_seen_at", ASCENDING)]),
    ],
    "refresh_tokens": [
        IndexModel([("device_id", ASCENDING)]),
        # TTL is only cleanup; expiry is always checked explicitly in queries.
        IndexModel([("expires_at", ASCENDING)], expireAfterSeconds=0),
    ],
    "friend_requests": [
        IndexModel([("pair_key", ASCENDING)], unique=True),
        IndexModel([("to_user_id", ASCENDING)]),
        IndexModel([("from_user_id", ASCENDING)]),
    ],
    "friendships": [IndexModel([("user_ids", ASCENDING)])],
    "envelopes": [
        IndexModel([("recipient_device_id", ASCENDING), ("_id", ASCENDING)]),
        IndexModel([("recipient_device_id", ASCENDING), ("sender_user_id", ASCENDING)]),
        IndexModel([("expires_at", ASCENDING)], expireAfterSeconds=0),
    ],
}


async def ensure_indexes(database: AsyncDatabase[dict[str, Any]]) -> None:
    """Create every index; re-running with identical specs is a no-op in MongoDB."""
    for collection, indexes in _INDEXES.items():
        await database[collection].create_indexes(indexes)
    logger.info("MongoDB indexes ensured on %d collections", len(_INDEXES))


async def ping(database: AsyncDatabase[dict[str, Any]]) -> None:
    await database.command("ping")
