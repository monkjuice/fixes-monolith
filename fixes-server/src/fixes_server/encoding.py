"""Strict standard base64 (RFC 4648 §4, with padding) for binary values in JSON (protocol §3)."""

from __future__ import annotations

import base64
import binascii


def decode_base64(value: str) -> bytes:
    """Decode canonical padded base64; reject URL-safe alphabets, whitespace and stray bits.

    Requiring the canonical form means one byte string has exactly one accepted encoding,
    which keeps uniqueness checks (e.g. device public keys) meaningful.
    """
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except (binascii.Error, UnicodeEncodeError) as exc:
        raise ValueError("must be standard base64 with padding") from exc
    if base64.b64encode(raw).decode("ascii") != value:
        raise ValueError("must be canonical standard base64 with padding")
    return raw


def encode_base64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")
