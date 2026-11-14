"""Short-lived JWT access tokens (protocol §5.5): HS256 with ``sub``, ``did``, ``typ``."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import jwt

from fixes_server.ids import is_uuid4

ACCESS_TOKEN_TTL = timedelta(minutes=15)
_ALGORITHM = "HS256"
_TYP_ACCESS = "access"


@dataclass(frozen=True, slots=True)
class AccessClaims:
    user_id: str
    device_id: str


class InvalidAccessTokenError(Exception):
    """The token is malformed, forged, expired or not an access token."""


class AccessTokenService:
    def __init__(self, secret: str) -> None:
        self._secret = secret

    @property
    def ttl_seconds(self) -> int:
        return int(ACCESS_TOKEN_TTL.total_seconds())

    def issue(self, user_id: str, device_id: str, now: datetime) -> str:
        payload = {
            "sub": user_id,
            "did": device_id,
            "typ": _TYP_ACCESS,
            "iat": int(now.timestamp()),
            "exp": int((now + ACCESS_TOKEN_TTL).timestamp()),
        }
        return jwt.encode(payload, self._secret, algorithm=_ALGORITHM)

    def verify(self, token: str) -> AccessClaims:
        try:
            claims = jwt.decode(
                token,
                self._secret,
                algorithms=[_ALGORITHM],
                options={"require": ["sub", "did", "typ", "iat", "exp"]},
            )
        except jwt.PyJWTError as exc:
            raise InvalidAccessTokenError(type(exc).__name__) from exc
        user_id, device_id = claims.get("sub"), claims.get("did")
        if claims.get("typ") != _TYP_ACCESS:
            raise InvalidAccessTokenError("wrong token type")
        if not (isinstance(user_id, str) and is_uuid4(user_id)):
            raise InvalidAccessTokenError("bad subject")
        if not (isinstance(device_id, str) and is_uuid4(device_id)):
            raise InvalidAccessTokenError("bad device id")
        return AccessClaims(user_id=user_id, device_id=device_id)
