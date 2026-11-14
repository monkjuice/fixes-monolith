from __future__ import annotations

import base64
import secrets
from datetime import UTC, datetime, timedelta

import anyio
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from fixes_server.blocking import create_limiter
from fixes_server.encoding import decode_base64
from fixes_server.ids import new_id
from fixes_server.security.access_tokens import AccessTokenService, InvalidAccessTokenError
from fixes_server.security.keys import (
    is_valid_x25519_public_key,
    verify_device_certificate,
)
from fixes_server.security.passwords import PasswordService
from fixes_server.security.refresh_tokens import REFRESH_TOKEN_LENGTH, new_refresh_token
from tests.helpers import b64, make_certificate
from tests.test_auth_login import LOW_ORDER_POINTS


def test_strict_base64() -> None:
    raw = secrets.token_bytes(32)
    assert decode_base64(base64.b64encode(raw).decode()) == raw
    for bad in (
        base64.urlsafe_b64encode(b"\xfb\xff" * 16).decode(),  # URL-safe alphabet
        base64.b64encode(raw).decode().rstrip("="),  # missing padding
        " " + base64.b64encode(raw).decode(),  # whitespace
        "QR==",  # non-canonical trailing bits (canonical form is "QQ==")
        "é",
    ):
        with pytest.raises(ValueError, match="base64"):
            decode_base64(bad)


def test_x25519_validation() -> None:
    assert is_valid_x25519_public_key(X25519PrivateKey.generate().public_key().public_bytes_raw())
    for raw in LOW_ORDER_POINTS.values():
        assert not is_valid_x25519_public_key(raw)
    assert not is_valid_x25519_public_key(b"\x07" * 31)
    assert not is_valid_x25519_public_key(b"")


def test_device_certificate_verification() -> None:
    identity = Ed25519PrivateKey.generate()
    identity_key = b64(identity.public_key().public_bytes_raw())
    user_id, device_id = new_id(), new_id()
    device_key = b64(X25519PrivateKey.generate().public_key().public_bytes_raw())
    certificate = make_certificate(identity, user_id, device_id, device_key)
    args = {
        "identity_key_b64": identity_key,
        "user_id": user_id,
        "device_id": device_id,
        "device_public_key_b64": device_key,
        "certificate_b64": certificate,
    }
    assert verify_device_certificate(**args)
    # Every element of the signed statement matters.
    for field, value in (
        ("user_id", new_id()),
        ("device_id", new_id()),
        ("device_public_key_b64", b64(bytes(32))),
        ("identity_key_b64", b64(Ed25519PrivateKey.generate().public_key().public_bytes_raw())),
        ("certificate_b64", b64(bytes(64))),
        ("certificate_b64", "not base64"),
        ("identity_key_b64", b64(b"\x01" * 33)),
    ):
        assert not verify_device_certificate(**{**args, field: value})


def test_access_tokens() -> None:
    service = AccessTokenService(secrets.token_urlsafe(40))
    user_id, device_id = new_id(), new_id()
    now = datetime.now(UTC)
    claims = service.verify(service.issue(user_id, device_id, now))
    assert (claims.user_id, claims.device_id) == (user_id, device_id)
    assert service.ttl_seconds == 900

    expired = service.issue(user_id, device_id, now - timedelta(minutes=16))
    with pytest.raises(InvalidAccessTokenError):
        service.verify(expired)
    other = AccessTokenService(secrets.token_urlsafe(40))
    with pytest.raises(InvalidAccessTokenError):
        other.verify(service.issue(user_id, device_id, now))
    with pytest.raises(InvalidAccessTokenError):
        service.verify("a.b.c")


def test_refresh_tokens_are_random_and_hashed() -> None:
    token, token_hash = new_refresh_token()
    other, _ = new_refresh_token()
    assert token != other
    assert len(token) == REFRESH_TOKEN_LENGTH
    assert len(base64.urlsafe_b64decode(token + "=")) == 32
    assert len(token_hash) == 64
    assert token not in token_hash


def test_password_service_dummy_verify() -> None:
    async def scenario() -> None:
        service = PasswordService(create_limiter())
        await service.initialize()
        password = secrets.token_urlsafe(12)
        stored = await service.hash(password)
        assert stored.startswith("$argon2id$v=19$m=65536,t=3,p=1$")
        assert await service.verify(stored, password)
        assert not await service.verify(stored, password + "x")
        assert not await service.verify(None, password)
        assert not await service.verify("not-a-hash", password)
        assert not service.needs_rehash(stored)

    anyio.run(scenario)


def test_password_service_requires_initialize() -> None:
    async def scenario() -> None:
        with pytest.raises(RuntimeError, match="initialize"):
            await PasswordService(create_limiter()).verify(None, "whatever")

    anyio.run(scenario)
