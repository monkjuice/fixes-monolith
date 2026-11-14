"""The device directory peers use to encrypt and verify (protocol §4.2, §5.3)."""

from __future__ import annotations

from pymongo import ASCENDING

from fixes_server.context import AppContext
from fixes_server.documents import DeviceDoc, UserDoc
from fixes_server.errors import not_found, not_friends
from fixes_server.services.friends import are_friends
from fixes_server.services.users import get_user


async def require_directory_access(ctx: AppContext, viewer_id: str, target_id: str) -> UserDoc:
    """Self and friends only: 404 for unknown users, then 403 ``not_friends``."""
    target = await get_user(ctx, target_id)
    if target_id != viewer_id and not await are_friends(ctx, viewer_id, target_id):
        raise not_friends()
    return target


async def linked_devices(ctx: AppContext, user_id: str) -> list[DeviceDoc]:
    cursor = ctx.db.devices.find(
        {"user_id": user_id, "revoked_at": None, "certificate": {"$ne": None}}
    ).sort([("created_at", ASCENDING), ("_id", ASCENDING)])
    return await cursor.to_list()


async def any_device(ctx: AppContext, user_id: str, device_id: str) -> DeviceDoc:
    """Any state, revoked included: senders' keys stay resolvable for old envelopes (§4.2)."""
    device = await ctx.db.devices.find_one({"_id": device_id, "user_id": user_id})
    if device is None:
        raise not_found("Device not found")
    return device
