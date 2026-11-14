"""Registration, password checks and password changes (protocol §5.3 Auth, §5.5, §5.6)."""

from __future__ import annotations

import logging

from pymongo.errors import DuplicateKeyError

from fixes_server.context import AppContext
from fixes_server.documents import UserDoc
from fixes_server.errors import conflict, device_revoked, invalid_credentials
from fixes_server.ids import new_id
from fixes_server.ratelimit import enforce
from fixes_server.services.revocation import active_device_ids, revoke_devices
from fixes_server.timeutil import utcnow

logger = logging.getLogger(__name__)


def _username_taken() -> Exception:
    return conflict("username_taken", "That username is already taken")


async def register_user(ctx: AppContext, username: str, password: str, ip: str) -> UserDoc:
    enforce((ctx.rate_limits.register, ip))
    username_lower = username.lower()
    # Cheap pre-check so taken names do not cost an argon2 hash; the unique index decides.
    if await ctx.db.users.find_one({"username_lower": username_lower}) is not None:
        raise _username_taken()
    user = UserDoc(
        _id=new_id(),
        username=username,
        username_lower=username_lower,
        password_hash=await ctx.passwords.hash(password),
        identity_key=None,
        avatar_key=None,
        created_at=utcnow(),
    )
    try:
        await ctx.db.users.insert_one(user)
    except DuplicateKeyError:
        raise _username_taken() from None
    return user


async def verify_password_limited(
    ctx: AppContext,
    *,
    username_lower: str,
    ip: str,
    password_hash: str | None,
    password: str,
) -> bool:
    """Check a password under the login limits: failures (§5.6) and successes per account.

    Tokens are taken *before* hashing (so parallel attempts cannot all slip through) and the
    side that did not happen is given back: a failure counts against the failure limits
    only, a success against the account's success limit only. ``password_hash=None`` runs
    the dummy verification for unknown users, so they count and cost exactly the same.
    """
    failure_checks = (
        (ctx.rate_limits.login_failures_user_ip, (username_lower, ip)),
        (ctx.rate_limits.login_failures_ip, ip),
    )
    success_check = (ctx.rate_limits.login_success, username_lower)
    enforce(*failure_checks, success_check)
    ok = await ctx.passwords.verify(password_hash, password)
    for limiter, key in failure_checks if ok else (success_check,):
        limiter.refund(key)
    return ok


async def authenticate(ctx: AppContext, username: str, password: str, ip: str) -> UserDoc:
    username_lower = username.lower()
    user = await ctx.db.users.find_one({"username_lower": username_lower})
    ok = await verify_password_limited(
        ctx,
        username_lower=username_lower,
        ip=ip,
        password_hash=user["password_hash"] if user else None,
        password=password,
    )
    if user is None or not ok:
        raise invalid_credentials()
    if ctx.passwords.needs_rehash(user["password_hash"]):
        new_hash = await ctx.passwords.hash(password)
        # Conditional on the verified hash: a password change that landed during the slow
        # check wins, instead of this re-encoding of the old password overwriting it. (Two
        # simultaneous logins upgrading the same hash look alike; the second one is refused
        # and simply retries. That happens at most once, right after the parameters change.)
        upgraded = await ctx.db.users.update_one(
            {"_id": user["_id"], "password_hash": user["password_hash"]},
            {"$set": {"password_hash": new_hash}},
        )
        if upgraded.matched_count == 0:
            raise invalid_credentials()
        user = {**user, "password_hash": new_hash}
        logger.info("password hash upgraded to current argon2 parameters")
    return user


async def password_unchanged(ctx: AppContext, user: UserDoc) -> bool:
    """Whether the stored password hash is still the one in ``user``.

    Password checks are slow (argon2 in the worker pool), so a password change can land
    between reading the user and acting on a successful check; callers re-check with this.
    """
    stored = await ctx.db.users.find_one({"_id": user["_id"]}, projection={"password_hash": True})
    return stored is not None and stored["password_hash"] == user["password_hash"]


async def require_password(ctx: AppContext, user: UserDoc, password: str, ip: str) -> None:
    """Re-authentication for sensitive actions; limited like logins."""
    ok = await verify_password_limited(
        ctx,
        username_lower=user["username_lower"],
        ip=ip,
        password_hash=user["password_hash"],
        password=password,
    )
    if not ok:
        raise invalid_credentials()


async def require_still_current(ctx: AppContext, user: UserDoc, device_id: str) -> None:
    """After a slow password check, confirm that the calling device was not revoked and the
    password was not changed meanwhile (both revoke this device's right to act)."""
    device = await ctx.db.devices.find_one(
        {"_id": device_id, "revoked_at": None}, projection={"_id": True}
    )
    if device is None:
        raise device_revoked()
    if not await password_unchanged(ctx, user):
        raise invalid_credentials()


async def _revoke_other_devices(ctx: AppContext, user_id: str, current_device_id: str) -> None:
    others = [d for d in await active_device_ids(ctx, user_id) if d != current_device_id]
    await revoke_devices(ctx, user_id, others)


async def change_password(
    ctx: AppContext,
    user: UserDoc,
    current_device_id: str,
    current_password: str,
    new_password: str,
    ip: str,
) -> None:
    """Set a new password and revoke every other device of the account (§5.3)."""
    await require_password(ctx, user, current_password, ip)
    new_hash = await ctx.passwords.hash(new_password)
    await require_still_current(ctx, user, current_device_id)
    # Other devices are revoked before the new hash is written: if this stops in between,
    # the old password is still valid and the same request succeeds when retried, instead
    # of a changed password with the devices the user wanted to lock out still signed in.
    await _revoke_other_devices(ctx, user["_id"], current_device_id)
    # Conditional on the verified hash, so of two concurrent changes only one applies.
    changed = await ctx.db.users.update_one(
        {"_id": user["_id"], "password_hash": user["password_hash"]},
        {"$set": {"password_hash": new_hash}},
    )
    if changed.matched_count == 0:
        raise invalid_credentials()
    # And again: a login that verified the old password may have stored a device since the
    # first pass. Login re-reads the hash after storing its device (routers/auth.py), so
    # such a device is either listed here or refused by the login itself.
    await _revoke_other_devices(ctx, user["_id"], current_device_id)
