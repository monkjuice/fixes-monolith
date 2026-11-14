"""Shapes of the MongoDB documents (protocol §11). Kept in one place as the schema reference."""

from __future__ import annotations

from datetime import datetime
from typing import TypedDict

from bson import ObjectId


class UserDoc(TypedDict):
    _id: str
    username: str
    username_lower: str
    password_hash: str
    identity_key: str | None
    avatar_key: str | None
    created_at: datetime


class DeviceDoc(TypedDict):
    _id: str
    user_id: str
    name: str
    public_key: str
    certificate: str | None
    created_at: datetime
    last_seen_at: datetime
    revoked_at: datetime | None
    overflow_at: datetime | None


class RefreshTokenDoc(TypedDict):
    _id: str  # SHA-256 hex of the token; the token itself is never stored
    user_id: str
    device_id: str
    created_at: datetime
    expires_at: datetime
    used_at: datetime | None
    replaced_by: str | None


class FriendRequestDoc(TypedDict):
    _id: str
    from_user_id: str
    to_user_id: str
    pair_key: str
    created_at: datetime


class FriendshipDoc(TypedDict):
    _id: str  # pair_key
    user_ids: list[str]
    created_at: datetime


class EnvelopeDoc(TypedDict):
    """A pending ciphertext envelope (services/envelopes.py). ``nonce`` and ``ciphertext``
    are BSON binary; ``size`` is the ciphertext length in bytes."""

    _id: ObjectId
    recipient_device_id: str
    recipient_user_id: str
    sender_user_id: str
    sender_device_id: str
    nonce: bytes
    ciphertext: bytes
    size: int
    created_at: datetime
    expires_at: datetime
