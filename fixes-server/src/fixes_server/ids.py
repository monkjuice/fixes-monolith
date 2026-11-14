"""Identifier generation and validation (protocol §3: lowercase UUIDv4 strings for users and
devices, ObjectId hex strings for envelopes)."""

from __future__ import annotations

import re
import uuid

from bson import ObjectId

UUID4_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
_UUID4_RE = re.compile(UUID4_PATTERN.removeprefix("^").removesuffix("$"))
# Envelope ids are ObjectId hex strings (§3), always lowercase as ObjectId renders them.
ENVELOPE_ID_PATTERN = r"^[0-9a-f]{24}$"


def new_id() -> str:
    return str(uuid.uuid4())


def is_uuid4(value: str) -> bool:
    return _UUID4_RE.fullmatch(value) is not None


def pair_key(user_a: str, user_b: str) -> str:
    """Order-independent key for a pair of users (protocol §11)."""
    first, second = sorted((user_a, user_b))
    return f"{first}:{second}"


class MonotonicObjectIds:
    """Envelope ids that strictly increase within this process (protocol §3).

    A fresh ObjectId (seconds + per-process random + counter) sorts in creation order except
    when the clock steps back or the 24-bit counter wraps within one second. Falling back to
    "previous + 1" keeps the order strict in those cases too; the event loop is single
    threaded, so no lock is needed.
    """

    def __init__(self) -> None:
        self._last: ObjectId | None = None

    def next(self) -> ObjectId:
        candidate = ObjectId()
        if self._last is not None and candidate <= self._last:
            successor = int.from_bytes(self._last.binary, "big") + 1
            candidate = ObjectId(successor.to_bytes(12, "big"))
        self._last = candidate
        return candidate
