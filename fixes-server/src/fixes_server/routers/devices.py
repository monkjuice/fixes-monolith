"""``/v1/devices`` endpoints: the caller's own devices (protocol §5.3 Identity & devices)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Response, status

from fixes_server.deps import Ctx, CurrentPrincipal
from fixes_server.ids import UUID4_PATTERN
from fixes_server.models.common import MyDevice
from fixes_server.models.devices import CertificateRequest, MyDeviceList
from fixes_server.services.devices import get_own_device, list_active_devices
from fixes_server.services.identity import certify_device
from fixes_server.services.presenters import my_device_out
from fixes_server.services.revocation import revoke_devices

router = APIRouter(prefix="/v1/devices", tags=["devices"])

DeviceId = Annotated[str, Path(pattern=UUID4_PATTERN)]


@router.get("")
async def list_devices(principal: CurrentPrincipal, ctx: Ctx) -> MyDeviceList:
    devices = await list_active_devices(ctx, principal.user_id)
    return MyDeviceList(devices=[my_device_out(d, principal.device_id) for d in devices])


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_device(device_id: DeviceId, principal: CurrentPrincipal, ctx: Ctx) -> Response:
    # Any state: revoking an already revoked device of one's own is an idempotent no-op.
    await get_own_device(ctx, principal.user_id, device_id, active_only=False)
    await revoke_devices(ctx, principal.user_id, [device_id])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{device_id}/certificate")
async def put_certificate(
    device_id: DeviceId, body: CertificateRequest, principal: CurrentPrincipal, ctx: Ctx
) -> MyDevice:
    device = await certify_device(ctx, principal, device_id, body.certificate)
    return my_device_out(device, principal.device_id)
