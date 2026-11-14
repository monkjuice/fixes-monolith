"""Account identity keys and device certificates (protocol §4.1, §5.3 Identity & devices)."""

from __future__ import annotations

from pymongo import ReturnDocument

from fixes_server.context import AppContext
from fixes_server.deps import Principal
from fixes_server.documents import DeviceDoc, UserDoc
from fixes_server.encoding import decode_base64
from fixes_server.errors import bad_request, conflict, not_found
from fixes_server.security.keys import is_valid_ed25519_public_key, verify_device_certificate
from fixes_server.services.accounts import require_password, require_still_current
from fixes_server.services.devices import get_own_device
from fixes_server.services.revocation import active_device_ids, revoke_devices


def validate_identity_key(identity_key_b64: str) -> None:
    try:
        raw = decode_base64(identity_key_b64)
    except ValueError:
        raw = b""
    if not is_valid_ed25519_public_key(raw):
        raise bad_request("invalid_public_key", "Identity key is not a valid Ed25519 public key")


def check_certificate(identity_key_b64: str, device: DeviceDoc, certificate_b64: str) -> None:
    if not verify_device_certificate(
        identity_key_b64=identity_key_b64,
        user_id=device["user_id"],
        device_id=device["_id"],
        device_public_key_b64=device["public_key"],
        certificate_b64=certificate_b64,
    ):
        raise bad_request("invalid_certificate", "Device certificate does not verify")


async def _store_certificate(ctx: AppContext, device_id: str, certificate_b64: str) -> DeviceDoc:
    device = await ctx.db.devices.find_one_and_update(
        {"_id": device_id, "revoked_at": None},
        {"$set": {"certificate": certificate_b64}},
        return_document=ReturnDocument.AFTER,
    )
    if device is None:
        # Revoked between the lookup and this write.
        raise not_found("Device not found")
    return device


async def set_identity(
    ctx: AppContext, principal: Principal, identity_key_b64: str, certificate_b64: str
) -> UserDoc:
    """First device: publish the account identity key and self-certify."""
    if principal.user["identity_key"] is not None:
        raise _identity_exists()
    validate_identity_key(identity_key_b64)
    check_certificate(identity_key_b64, principal.device, certificate_b64)
    # Conditional write: of two devices racing to create the identity, exactly one wins.
    # The key is stored before the certificate; after a crash in between, the device still
    # holds the identity secret and self-certifies through PUT /v1/devices/{id}/certificate.
    user = await ctx.db.users.find_one_and_update(
        {"_id": principal.user_id, "identity_key": None},
        {"$set": {"identity_key": identity_key_b64}},
        return_document=ReturnDocument.AFTER,
    )
    if user is None:
        raise _identity_exists()
    await _store_certificate(ctx, principal.device_id, certificate_b64)
    await ctx.hooks.notify_devices_changed(principal.user_id)
    return user


def _identity_exists() -> Exception:
    return conflict("identity_exists", "This account already has an identity key")


async def certify_device(
    ctx: AppContext, principal: Principal, device_id: str, certificate_b64: str
) -> DeviceDoc:
    device = await get_own_device(ctx, principal.user_id, device_id, active_only=True)
    identity_key = principal.user["identity_key"]
    if identity_key is None:
        raise bad_request(
            "invalid_certificate", "The account has no identity key to verify certificates with"
        )
    check_certificate(identity_key, device, certificate_b64)
    stored = await _store_certificate(ctx, device_id, certificate_b64)
    await ctx.hooks.notify_devices_changed(principal.user_id)
    return stored


async def reset_identity(
    ctx: AppContext,
    principal: Principal,
    *,
    password: str,
    identity_key_b64: str,
    certificate_b64: str,
    ip: str,
) -> UserDoc:
    """Replace a lost identity: verify password, revoke other devices, swap key, certify."""
    await require_password(ctx, principal.user, password, ip)
    # Validate everything before the first write so a bad request changes nothing.
    validate_identity_key(identity_key_b64)
    check_certificate(identity_key_b64, principal.device, certificate_b64)
    # The password check is slow: a password change or a revocation of this device may have
    # landed meanwhile, and either one takes away this device's right to sign others out.
    await require_still_current(ctx, principal.user, principal.device_id)

    others = [
        d for d in await active_device_ids(ctx, principal.user_id) if d != principal.device_id
    ]
    await revoke_devices(ctx, principal.user_id, others, notify=False)
    user = await ctx.db.users.find_one_and_update(
        {"_id": principal.user_id},
        {"$set": {"identity_key": identity_key_b64}},
        return_document=ReturnDocument.AFTER,
    )
    if user is None:
        raise not_found("User not found")
    await _store_certificate(ctx, principal.device_id, certificate_b64)
    await ctx.hooks.notify_devices_changed(principal.user_id)
    return user
