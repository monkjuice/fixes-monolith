"""FastAPI dependencies: the shared context and the authenticated principal."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated, cast

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.requests import HTTPConnection

from fixes_server.context import AppContext
from fixes_server.documents import DeviceDoc, UserDoc
from fixes_server.errors import device_revoked, unauthorized
from fixes_server.security.access_tokens import InvalidAccessTokenError
from fixes_server.timeutil import utcnow

LAST_SEEN_RESOLUTION = timedelta(hours=1)

# auto_error=False: a missing header must produce our §5.1 401, not FastAPI's 403.
_bearer = HTTPBearer(auto_error=False)


def get_context(connection: HTTPConnection) -> AppContext:
    return cast(AppContext, connection.app.state.ctx)


Ctx = Annotated[AppContext, Depends(get_context)]


@dataclass(frozen=True, slots=True)
class Principal:
    user: UserDoc
    device: DeviceDoc

    @property
    def user_id(self) -> str:
        return self.user["_id"]

    @property
    def device_id(self) -> str:
        return self.device["_id"]


async def authenticate_access_token(
    ctx: AppContext, token: str, *, touch_last_seen: bool = True
) -> Principal:
    """Resolve an access token to its user and active device, or raise 401.

    Shared with the WebSocket ``auth`` frame, which calls it with ``touch_last_seen=False``
    and then sets ``last_seen_at`` unconditionally (§5.4, see realtime/session.py).
    """
    try:
        claims = ctx.access_tokens.verify(token)
    except InvalidAccessTokenError:
        raise unauthorized() from None
    device = await ctx.db.devices.find_one({"_id": claims.device_id})
    if device is None or device["user_id"] != claims.user_id:
        raise unauthorized()
    if device["revoked_at"] is not None:
        raise device_revoked()
    user = await ctx.db.users.find_one({"_id": claims.user_id})
    if user is None:
        raise unauthorized()
    if touch_last_seen:
        device = await _touch_last_seen(ctx, device)
    return Principal(user=user, device=device)


async def _touch_last_seen(ctx: AppContext, device: DeviceDoc) -> DeviceDoc:
    now = utcnow()
    threshold = now - LAST_SEEN_RESOLUTION
    if device["last_seen_at"] >= threshold:
        return device
    # Conditional so concurrent requests write at most once per hour.
    await ctx.db.devices.update_one(
        {"_id": device["_id"], "last_seen_at": {"$lt": threshold}},
        {"$set": {"last_seen_at": now}},
    )
    return {**device, "last_seen_at": now}


async def get_principal(
    ctx: Ctx,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Principal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise unauthorized()
    return await authenticate_access_token(ctx, credentials.credentials)


CurrentPrincipal = Annotated[Principal, Depends(get_principal)]
