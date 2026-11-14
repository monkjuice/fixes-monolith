"""``/v1/users`` endpoints (protocol §5.3 Users, Identity & devices)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, Path, Query, UploadFile

from fixes_server.deps import Ctx, CurrentPrincipal
from fixes_server.errors import validation_error
from fixes_server.ids import UUID4_PATTERN, is_uuid4
from fixes_server.models.common import (
    SEARCH_QUERY_PATTERN,
    DeviceInfo,
    Me,
    MeEnvelope,
    User,
)
from fixes_server.models.devices import PeerDeviceList, SetIdentityRequest
from fixes_server.models.users import UserList
from fixes_server.ratelimit import enforce
from fixes_server.services.avatars import replace_avatar
from fixes_server.services.directory import any_device, linked_devices, require_directory_access
from fixes_server.services.identity import set_identity
from fixes_server.services.presenters import (
    device_info_out,
    me_out,
    peer_device_out,
    user_out,
)
from fixes_server.services.users import get_user, lookup_users, search_users

router = APIRouter(prefix="/v1/users", tags=["users"])

UserId = Annotated[str, Path(pattern=UUID4_PATTERN)]
DeviceId = Annotated[str, Path(pattern=UUID4_PATTERN)]
MAX_LOOKUP_IDS = 100


# Routes under /me are declared first: /v1/users/{user_id} would otherwise capture "me".


@router.get("/me")
async def get_me(principal: CurrentPrincipal, ctx: Ctx) -> Me:
    return me_out(principal.user, ctx.storage)


@router.put("/me/identity")
async def put_identity(
    body: SetIdentityRequest, principal: CurrentPrincipal, ctx: Ctx
) -> MeEnvelope:
    user = await set_identity(ctx, principal, body.identity_key, body.device_certificate)
    return MeEnvelope(user=me_out(user, ctx.storage))


@router.put("/me/avatar")
async def put_avatar(
    image: Annotated[UploadFile, File()], principal: CurrentPrincipal, ctx: Ctx
) -> MeEnvelope:
    user = await replace_avatar(ctx, principal.user_id, image)
    return MeEnvelope(user=me_out(user, ctx.storage))


def _parse_ids(raw: str) -> list[str]:
    ids = raw.split(",")
    if not 1 <= len(ids) <= MAX_LOOKUP_IDS:
        raise validation_error({"ids": f"must contain 1-{MAX_LOOKUP_IDS} user ids"})
    if not all(is_uuid4(user_id) for user_id in ids):
        raise validation_error({"ids": "must be comma-separated lowercase UUIDv4 values"})
    return list(dict.fromkeys(ids))


@router.get("")
async def find_users(
    principal: CurrentPrincipal,
    ctx: Ctx,
    q: Annotated[str | None, Query(pattern=SEARCH_QUERY_PATTERN)] = None,
    ids: Annotated[str | None, Query(max_length=MAX_LOOKUP_IDS * 37)] = None,
) -> UserList:
    """Search by ``q`` or look up by ``ids``; exactly one of them (both share one limit)."""
    if q is not None and ids is not None:
        raise validation_error(
            {"q": "q and ids are mutually exclusive", "ids": "q and ids are mutually exclusive"}
        )
    if q is not None:
        enforce((ctx.rate_limits.user_lookup, principal.user_id))
        users = await search_users(ctx, q, exclude_user_id=principal.user_id)
    elif ids is not None:
        # Parsed first so malformed requests do not spend the caller's lookup budget.
        user_ids = _parse_ids(ids)
        enforce((ctx.rate_limits.user_lookup, principal.user_id))
        users = await lookup_users(ctx, user_ids)
    else:
        raise validation_error({"q": "either q or ids is required"})
    return UserList(users=[user_out(u, ctx.storage) for u in users])


@router.get("/{user_id}")
async def get_user_by_id(user_id: UserId, principal: CurrentPrincipal, ctx: Ctx) -> User:
    return user_out(await get_user(ctx, user_id), ctx.storage)


@router.get("/{user_id}/devices")
async def get_user_devices(
    user_id: UserId, principal: CurrentPrincipal, ctx: Ctx
) -> PeerDeviceList:
    target = await require_directory_access(ctx, principal.user_id, user_id)
    devices = await linked_devices(ctx, user_id)
    return PeerDeviceList(
        identity_key=target["identity_key"], devices=[peer_device_out(d) for d in devices]
    )


@router.get("/{user_id}/devices/{device_id}")
async def get_user_device(
    user_id: UserId, device_id: DeviceId, principal: CurrentPrincipal, ctx: Ctx
) -> DeviceInfo:
    await require_directory_access(ctx, principal.user_id, user_id)
    return device_info_out(await any_device(ctx, user_id, device_id))
