"""Validation of client public values: X25519 device keys and Ed25519 certificates (§4.1)."""

from __future__ import annotations

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey

from fixes_server.encoding import decode_base64

KEY_LENGTH = 32
SIGNATURE_LENGTH = 64
_CERT_PREFIX = "fixes/v1/device-cert|"

# One random scalar per process. Clamped X25519 scalars are multiples of 8, so a peer key on
# a small-order point yields the all-zero shared secret for every such scalar; one probe is
# enough to detect it.
_PROBE_KEY = X25519PrivateKey.generate()


def is_valid_x25519_public_key(raw: bytes) -> bool:
    if len(raw) != KEY_LENGTH:
        return False
    try:
        shared = _PROBE_KEY.exchange(X25519PublicKey.from_public_bytes(raw))
    except ValueError:
        # OpenSSL refuses to return an all-zero shared secret and raises instead.
        return False
    return shared != bytes(KEY_LENGTH)


def is_valid_ed25519_public_key(raw: bytes) -> bool:
    if len(raw) != KEY_LENGTH:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(raw)
    except ValueError:
        return False
    return True


def device_certificate_message(user_id: str, device_id: str, device_public_key_b64: str) -> bytes:
    return f"{_CERT_PREFIX}{user_id}|{device_id}|{device_public_key_b64}".encode()


def verify_device_certificate(
    *,
    identity_key_b64: str,
    user_id: str,
    device_id: str,
    device_public_key_b64: str,
    certificate_b64: str,
) -> bool:
    """True when ``certificate`` is the AIK's Ed25519 signature over the device statement."""
    try:
        identity_key = decode_base64(identity_key_b64)
        signature = decode_base64(certificate_b64)
    except ValueError:
        return False
    if len(signature) != SIGNATURE_LENGTH or not is_valid_ed25519_public_key(identity_key):
        return False
    message = device_certificate_message(user_id, device_id, device_public_key_b64)
    try:
        Ed25519PublicKey.from_public_bytes(identity_key).verify(signature, message)
    except InvalidSignature:
        return False
    return True
