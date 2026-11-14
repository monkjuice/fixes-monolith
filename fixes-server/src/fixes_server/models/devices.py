"""Bodies of the identity and device endpoints."""

from __future__ import annotations

from pydantic import BaseModel

from fixes_server.models.common import (
    MyDevice,
    PeerDevice,
    PublicKeyB64,
    RequestModel,
    SignatureB64,
)


class SetIdentityRequest(RequestModel):
    identity_key: PublicKeyB64
    device_certificate: SignatureB64


class CertificateRequest(RequestModel):
    certificate: SignatureB64


class MyDeviceList(BaseModel):
    devices: list[MyDevice]


class PeerDeviceList(BaseModel):
    identity_key: str | None
    devices: list[PeerDevice]
