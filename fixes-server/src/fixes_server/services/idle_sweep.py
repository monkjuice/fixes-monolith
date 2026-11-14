"""Revocation of idle devices (protocol §5.4): at startup and then hourly."""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta

import anyio

from fixes_server.context import AppContext
from fixes_server.services.revocation import revoke_devices
from fixes_server.timeutil import utcnow

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 3600.0


async def finish_interrupted_revocations(ctx: AppContext) -> int:
    """Finish revocations that stopped before deleting the device's pending envelopes.

    A revocation sets ``revoked_at`` first (§5.4), so if a later step fails, the next sweep no
    longer sees the device as idle; and an idle device has no live refresh token whose use
    would finish it. A revoked device that still has envelopes is such a leftover; running
    the (idempotent) revocation again deletes them and catches up on the remaining steps.
    """
    with_envelopes = await ctx.db.envelopes.distinct("recipient_device_id")
    if not with_envelopes:
        return 0
    by_user: dict[str, list[str]] = defaultdict(list)
    revoked = {"_id": {"$in": with_envelopes}, "revoked_at": {"$ne": None}}
    async for device in ctx.db.devices.find(revoked, projection={"_id": True, "user_id": True}):
        by_user[device["user_id"]].append(device["_id"])
    finished = 0
    for user_id, device_ids in by_user.items():
        finished += len(await revoke_devices(ctx, user_id, device_ids))
    if finished:
        logger.info("finished %d interrupted revocation(s)", finished)
    return finished


async def sweep_idle_devices(ctx: AppContext, *, now: datetime | None = None) -> int:
    """Revoke active devices unseen for ``FIXES_DEVICE_IDLE_DAYS``; returns how many.

    Interrupted revocations left by earlier runs (or any other revocation) are finished
    first, so a failure in this run cannot keep them from being retried.
    """
    await finish_interrupted_revocations(ctx)
    now = now or utcnow()
    cutoff = now - timedelta(days=ctx.settings.device_idle_days)
    idle = {"revoked_at": None, "last_seen_at": {"$lt": cutoff}}
    by_user: dict[str, list[str]] = defaultdict(list)
    async for device in ctx.db.devices.find(idle, projection={"_id": True, "user_id": True}):
        by_user[device["user_id"]].append(device["_id"])

    revoked = 0
    for user_id, device_ids in by_user.items():
        # Conditional first step: a device seen again since the query keeps working.
        await ctx.db.devices.update_many(
            {"_id": {"$in": device_ids}, **idle}, {"$set": {"revoked_at": now}}
        )
        confirmed = await ctx.db.devices.distinct(
            "_id", {"_id": {"$in": device_ids}, "revoked_at": {"$ne": None}}
        )
        # revoke_devices is idempotent: it keeps revoked_at and runs the remaining §5.4 steps.
        revoked += len(await revoke_devices(ctx, user_id, [str(d) for d in confirmed]))
    return revoked


async def run_idle_sweeper(
    ctx: AppContext, *, interval_seconds: float = SWEEP_INTERVAL_SECONDS
) -> None:
    """Sweep now and then every ``interval_seconds`` until cancelled (lifespan shutdown)."""
    while True:
        try:
            revoked = await sweep_idle_devices(ctx)
        except Exception:
            # Maintenance must not take the API down: log it and let the next run retry.
            logger.exception("idle device sweep failed")
        else:
            if revoked:
                logger.info("idle sweep revoked %d device(s)", revoked)
        await anyio.sleep(interval_seconds)
