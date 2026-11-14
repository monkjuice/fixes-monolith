"""``/v1/auth`` endpoints (protocol §5.3 Auth)."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response, status

from fixes_server.deps import Ctx, CurrentPrincipal
from fixes_server.errors import invalid_credentials
from fixes_server.models.auth import (
    LoginRequest,
    LoginResponse,
    PasswordChangeRequest,
    RefreshRequest,
    RegisterRequest,
    ResetIdentityRequest,
)
from fixes_server.models.common import MeEnvelope, Tokens, UserEnvelope
from fixes_server.ratelimit import client_ip_key
from fixes_server.services.accounts import (
    authenticate,
    change_password,
    password_unchanged,
    register_user,
)
from fixes_server.services.devices import create_device, validate_device_public_key
from fixes_server.services.identity import reset_identity
from fixes_server.services.presenters import me_out, my_device_out, user_out
from fixes_server.services.revocation import revoke_devices
from fixes_server.services.sessions import issue_tokens, rotate_refresh_token

router = APIRouter(prefix="/v1/auth", tags=["auth"])


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest, request: Request, ctx: Ctx) -> UserEnvelope:
    user = await register_user(ctx, body.username, body.password, client_ip_key(request))
    return UserEnvelope(user=user_out(user, ctx.storage))


@router.post("/login")
async def login(body: LoginRequest, request: Request, ctx: Ctx) -> LoginResponse:
    # Key validation is cheap and independent of the account, so it runs before argon2.
    validate_device_public_key(body.device.public_key)
    user = await authenticate(ctx, body.username, body.password, client_ip_key(request))
    device = await create_device(ctx, user["_id"], body.device.name, body.device.public_key)
    # A password change may have landed while the old password was being verified. It writes
    # the new hash before listing the devices to revoke, so either it revokes this device or
    # this re-read sees the new hash (§5.3: a password change revokes all other devices).
    if not await password_unchanged(ctx, user):
        await revoke_devices(ctx, user["_id"], [device["_id"]], notify=False)
        raise invalid_credentials()
    tokens = await issue_tokens(ctx, user["_id"], device["_id"])
    await ctx.hooks.notify_devices_changed(user["_id"], exclude_device_ids=[device["_id"]])
    return LoginResponse(
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        expires_in=tokens.expires_in,
        user=me_out(user, ctx.storage),
        device=my_device_out(device, device["_id"]),
    )


@router.post("/refresh")
async def refresh(body: RefreshRequest, ctx: Ctx) -> Tokens:
    return await rotate_refresh_token(ctx, body.refresh_token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(principal: CurrentPrincipal, ctx: Ctx) -> Response:
    await revoke_devices(ctx, principal.user_id, [principal.device_id])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
async def password(
    body: PasswordChangeRequest, request: Request, principal: CurrentPrincipal, ctx: Ctx
) -> Response:
    await change_password(
        ctx,
        principal.user,
        principal.device_id,
        body.current_password,
        body.new_password,
        client_ip_key(request),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/reset-identity")
async def reset_identity_endpoint(
    body: ResetIdentityRequest, request: Request, principal: CurrentPrincipal, ctx: Ctx
) -> MeEnvelope:
    user = await reset_identity(
        ctx,
        principal,
        password=body.password,
        identity_key_b64=body.identity_key,
        certificate_b64=body.device_certificate,
        ip=client_ip_key(request),
    )
    return MeEnvelope(user=me_out(user, ctx.storage))
