"""Device revocation (protocol §5.4), shared by logout, device deletion, password change,
identity reset, refresh-token reuse, the idle sweep and interrupted revocations found by
refresh."""

from __future__ import annotations

import logging
from collections.abc import Iterable

from fixes_server.context import AppContext
from fixes_server.timeutil import utcnow

logger = logging.getLogger(__name__)


async def revoke_devices(
    ctx: AppContext, user_id: str, device_ids: Iterable[str], *, notify: bool = True
) -> list[str]:
    """Revoke the given devices of ``user_id``; returns the ids that belong to that user.

    The step order is the crash-safe order of §5.4 and every step is idempotent, so calling
    this again for an already (partly) revoked device simply finishes the job:

    1. ``revoked_at`` - every authenticated request checks it, so access ends here;
    2. delete the device's refresh tokens;
    3. delete its pending envelopes            (hook);
    4. close its WebSocket with 4401           (hook);
    5. ``devices_changed`` to remaining sockets (hook; skipped with ``notify=False``
       when the caller sends one notification after further changes).
    """
    requested = sorted(set(device_ids))
    if not requested:
        return []
    # Scope to the owner so a caller can never revoke someone else's device by id.
    owned = await ctx.db.devices.distinct("_id", {"_id": {"$in": requested}, "user_id": user_id})
    ids = sorted(str(device_id) for device_id in owned)
    if not ids:
        return []

    await ctx.db.devices.update_many(
        {"_id": {"$in": ids}, "revoked_at": None}, {"$set": {"revoked_at": utcnow()}}
    )
    await ctx.db.refresh_tokens.delete_many({"device_id": {"$in": ids}})
    await ctx.hooks.delete_pending_envelopes(ids)
    await ctx.hooks.close_device_sockets(ids)
    if notify:
        await ctx.hooks.notify_devices_changed(user_id, exclude_device_ids=ids)
    logger.info("revoked %d device(s)", len(ids))
    return ids


async def active_device_ids(ctx: AppContext, user_id: str) -> list[str]:
    ids = await ctx.db.devices.distinct("_id", {"user_id": user_id, "revoked_at": None})
    return sorted(str(device_id) for device_id in ids)
