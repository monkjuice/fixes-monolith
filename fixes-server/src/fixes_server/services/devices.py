"""Device registration and lookup (protocol §5.3 login and devices, §5.4)."""

from __future__ import annotations

from pymongo import ASCENDING
from pymongo.errors import DuplicateKeyError

from fixes_server.context import AppContext
from fixes_server.documents import DeviceDoc
from fixes_server.encoding import decode_base64
from fixes_server.errors import bad_request, conflict, not_found
from fixes_server.ids import new_id
from fixes_server.security.keys import is_valid_x25519_public_key
from fixes_server.timeutil import isoformat_utc, utcnow

MAX_ACTIVE_DEVICES = 10


def validate_device_public_key(public_key_b64: str) -> None:
    """32-byte X25519 key that is not a low-order point; else 400 ``invalid_public_key``."""
    try:
        raw = decode_base64(public_key_b64)
    except ValueError:
        raw = b""
    if not is_valid_x25519_public_key(raw):
        raise bad_request("invalid_public_key", "Device public key is not a valid X25519 key")


async def list_active_devices(ctx: AppContext, user_id: str) -> list[DeviceDoc]:
    cursor = ctx.db.devices.find({"user_id": user_id, "revoked_at": None}).sort(
        [("created_at", ASCENDING), ("_id", ASCENDING)]
    )
    return await cursor.to_list()


async def create_device(ctx: AppContext, user_id: str, name: str, public_key_b64: str) -> DeviceDoc:
    """Register a new unlinked device. The key must already be validated by the caller."""
    active = await list_active_devices(ctx, user_id)
    # Without transactions two simultaneous logins can both pass this check; the cap is a
    # product limit, not a security boundary, so that rare overshoot is accepted.
    if len(active) >= MAX_ACTIVE_DEVICES:
        raise conflict(
            "too_many_devices",
            f"At most {MAX_ACTIVE_DEVICES} devices can be signed in; sign one out first",
            details={
                "devices": [
                    {
                        "id": d["_id"],
                        "name": d["name"],
                        "last_seen_at": isoformat_utc(d["last_seen_at"]),
                    }
                    for d in active
                ]
            },
        )
    now = utcnow()
    device = DeviceDoc(
        _id=new_id(),
        user_id=user_id,
        name=name,
        public_key=public_key_b64,
        certificate=None,
        created_at=now,
        last_seen_at=now,
        revoked_at=None,
        overflow_at=None,
    )
    try:
        await ctx.db.devices.insert_one(device)
    except DuplicateKeyError:
        # Only public_key can collide (the _id is a fresh UUID). Keys are never reusable,
        # even after revocation, because device documents are kept forever (§11).
        raise conflict("device_key_in_use", "This device key is already registered") from None
    return device


async def get_own_device(
    ctx: AppContext, user_id: str, device_id: str, *, active_only: bool
) -> DeviceDoc:
    query: dict[str, object] = {"_id": device_id, "user_id": user_id}
    if active_only:
        query["revoked_at"] = None
    device = await ctx.db.devices.find_one(query)
    if device is None:
        raise not_found("Device not found")
    return device
