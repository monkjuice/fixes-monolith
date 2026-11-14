"""Access/refresh token issuance and refresh-token rotation (protocol §5.3 refresh, §5.5)."""

from __future__ import annotations

import logging
from datetime import datetime

from pymongo import ReturnDocument

from fixes_server.context import AppContext
from fixes_server.documents import RefreshTokenDoc
from fixes_server.errors import device_revoked, invalid_refresh_token
from fixes_server.models.common import Tokens
from fixes_server.ratelimit import enforce
from fixes_server.security.refresh_tokens import (
    REFRESH_REUSE_GRACE,
    REFRESH_TOKEN_TTL,
    hash_refresh_token,
    new_refresh_token,
)
from fixes_server.services.revocation import revoke_devices
from fixes_server.timeutil import utcnow

logger = logging.getLogger(__name__)


async def _store_refresh_token(
    ctx: AppContext, user_id: str, device_id: str, now: datetime
) -> tuple[str, str]:
    token, token_hash = new_refresh_token()
    await ctx.db.refresh_tokens.insert_one(
        RefreshTokenDoc(
            _id=token_hash,
            user_id=user_id,
            device_id=device_id,
            created_at=now,
            # Sliding expiry: every new token lives for the full lifetime.
            expires_at=now + REFRESH_TOKEN_TTL,
            used_at=None,
            replaced_by=None,
        )
    )
    return token, token_hash


def _tokens(ctx: AppContext, user_id: str, device_id: str, refresh: str, now: datetime) -> Tokens:
    return Tokens(
        access_token=ctx.access_tokens.issue(user_id, device_id, now),
        refresh_token=refresh,
        expires_in=ctx.access_tokens.ttl_seconds,
    )


async def issue_tokens(ctx: AppContext, user_id: str, device_id: str) -> Tokens:
    now = utcnow()
    refresh, _ = await _store_refresh_token(ctx, user_id, device_id, now)
    return _tokens(ctx, user_id, device_id, refresh, now)


async def _consume(
    ctx: AppContext, token_hash: str, successor_hash: str, now: datetime
) -> RefreshTokenDoc | None:
    """Atomically mark an unused, unexpired token as used and link its successor."""
    return await ctx.db.refresh_tokens.find_one_and_update(
        {"_id": token_hash, "used_at": None, "expires_at": {"$gt": now}},
        {"$set": {"used_at": now, "replaced_by": successor_hash}},
        return_document=ReturnDocument.AFTER,
    )


async def rotate_refresh_token(ctx: AppContext, token: str) -> Tokens:
    if not token.isascii():
        # Real tokens are base64url (ASCII), and the hash is taken over their ASCII bytes:
        # any other text is simply an unknown token, not a server error.
        raise invalid_refresh_token()
    token_hash = hash_refresh_token(token)
    existing = await ctx.db.refresh_tokens.find_one({"_id": token_hash})
    if existing is None:
        raise invalid_refresh_token()
    user_id, device_id = existing["user_id"], existing["device_id"]

    enforce((ctx.rate_limits.refresh, device_id))
    device = await ctx.db.devices.find_one({"_id": device_id})
    if device is None or device["user_id"] != user_id:
        raise invalid_refresh_token()
    if device["revoked_at"] is not None:
        # Revocation deletes refresh tokens in its second step, so a token that still exists
        # means that revocation was interrupted. Finish it (idempotent) before answering.
        await revoke_devices(ctx, user_id, [device_id])
        raise device_revoked()

    now = utcnow()
    # The successor is stored before the old token is marked used: a crash in between leaves
    # an orphan (never handed out, removed by TTL) instead of a "used" token with no successor,
    # which a client retry would otherwise trip over as reuse.
    new_token, new_hash = await _store_refresh_token(ctx, user_id, device_id, now)
    if await _consume(ctx, token_hash, new_hash, now) is not None:
        return await _finish(ctx, user_id, device_id, new_token, now)
    await ctx.db.refresh_tokens.delete_one({"_id": new_hash})

    current = await ctx.db.refresh_tokens.find_one({"_id": token_hash})
    if current is None:
        # Deleted meanwhile, e.g. by a concurrent revocation.
        raise invalid_refresh_token()
    used_at = current["used_at"]
    if used_at is None:
        # Not consumed, so the filter failed on expires_at: expired, not reused.
        raise invalid_refresh_token()

    successor = current["replaced_by"]
    if successor is not None and now - used_at < REFRESH_REUSE_GRACE:
        # A client that lost the response retries with the old token: hand out a fresh pair,
        # provided the successor it never saw is still unused.
        retry_token, retry_hash = await _store_refresh_token(ctx, user_id, device_id, now)
        if await _consume(ctx, successor, retry_hash, now) is not None:
            return await _finish(ctx, user_id, device_id, retry_token, now)
        await ctx.db.refresh_tokens.delete_one({"_id": retry_hash})

    # Reuse of a consumed token means it leaked: whoever holds the newer one is cut off too.
    logger.warning("refresh token reuse detected; revoking the device")
    await revoke_devices(ctx, user_id, [device_id])
    raise invalid_refresh_token()


async def _finish(
    ctx: AppContext, user_id: str, device_id: str, refresh: str, now: datetime
) -> Tokens:
    await ctx.db.devices.update_one({"_id": device_id}, {"$set": {"last_seen_at": now}})
    return _tokens(ctx, user_id, device_id, refresh, now)
