"""Field types and the shared response shapes of protocol §5.2."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, PlainSerializer, StringConstraints

from fixes_server.encoding import decode_base64
from fixes_server.ids import UUID4_PATTERN
from fixes_server.timeutil import isoformat_utc

USERNAME_PATTERN = r"^[A-Za-z0-9_]{3,30}$"
SEARCH_QUERY_PATTERN = r"^[A-Za-z0-9_]{1,30}$"


def _check_base64(value: str) -> str:
    decode_base64(value)
    return value


UtcDateTime = Annotated[datetime, PlainSerializer(isoformat_utc, return_type=str)]
Uuid = Annotated[str, StringConstraints(pattern=UUID4_PATTERN)]
Username = Annotated[str, StringConstraints(pattern=USERNAME_PATTERN)]
Password = Annotated[str, StringConstraints(min_length=8, max_length=128)]
# Login accepts anything bounded so a malformed username is just "invalid credentials".
LoginUsername = Annotated[str, StringConstraints(min_length=1, max_length=64)]
LoginPassword = Annotated[str, StringConstraints(min_length=1, max_length=128)]
DeviceName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
# Length bounds keep oversized strings out before decoding; exact byte lengths are checked by
# the services so they can answer with the §5.1 code (invalid_public_key, invalid_certificate).
PublicKeyB64 = Annotated[str, StringConstraints(max_length=64), AfterValidator(_check_base64)]
SignatureB64 = Annotated[str, StringConstraints(max_length=128), AfterValidator(_check_base64)]


class RequestModel(BaseModel):
    """Base for request bodies: unknown fields are rejected so client bugs surface early."""

    model_config = ConfigDict(extra="forbid")


class User(BaseModel):
    id: str
    username: str
    avatar_url: str | None


class Me(User):
    identity_key: str | None


class MyDevice(BaseModel):
    id: str
    name: str
    public_key: str
    certificate: str | None
    created_at: UtcDateTime
    last_seen_at: UtcDateTime
    current: bool


class PeerDevice(BaseModel):
    id: str
    public_key: str
    certificate: str


class DeviceInfo(BaseModel):
    id: str
    user_id: str
    public_key: str
    certificate: str | None
    revoked_at: UtcDateTime | None


class FriendRequest(BaseModel):
    id: str
    from_user: User
    to_user: User
    created_at: UtcDateTime


class Envelope(BaseModel):
    id: str
    sender_user_id: str
    sender_device_id: str
    recipient_device_id: str
    nonce: str
    ciphertext: str
    created_at: UtcDateTime


class Tokens(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"  # noqa: S105 - OAuth token type, not a secret
    expires_in: int


class UserEnvelope(BaseModel):
    """``{"user": User}`` (register)."""

    user: User


class MeEnvelope(BaseModel):
    """``{"user": Me}`` (identity, reset-identity, avatar)."""

    user: Me


class HealthStatus(BaseModel):
    status: Literal["ok"] = "ok"
