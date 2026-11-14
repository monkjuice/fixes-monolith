"""Opaque refresh-token primitives (protocol §5.5). Rotation lives in services/sessions.py."""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

REFRESH_TOKEN_TTL = timedelta(days=30)
REFRESH_REUSE_GRACE = timedelta(seconds=60)
_TOKEN_BYTES = 32
# 32 random bytes in unpadded base64url are always 43 characters.
REFRESH_TOKEN_LENGTH = 43


def new_refresh_token() -> tuple[str, str]:
    """Return ``(token, sha256_hex)``. Only the hash is ever persisted."""
    token = secrets.token_urlsafe(_TOKEN_BYTES)
    return token, hash_refresh_token(token)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()
