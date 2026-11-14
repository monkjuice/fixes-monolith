"""Wire format of ``/v1/ws`` (protocol §6): close codes and server-to-client messages."""

from __future__ import annotations

import json
from typing import Any

from fixes_server.models.common import Envelope

# Application close codes of §6, with the client reaction they trigger.
CLOSE_UNAUTHORIZED = 4401  # bad token or revoked device: refresh once, maybe sign out
CLOSE_AUTH_TIMEOUT = 4408  # no auth frame in time: reconnect with backoff
CLOSE_REPLACED = 4409  # a newer socket took over this device: stay away until foreground

# Standard codes (RFC 6455) for everything else; clients reconnect with backoff (§6 "other").
CLOSE_NORMAL = 1000
CLOSE_UNSUPPORTED_DATA = 1003
CLOSE_POLICY_VIOLATION = 1008
CLOSE_MESSAGE_TOO_BIG = 1009
CLOSE_INTERNAL_ERROR = 1011
CLOSE_SERVICE_RESTART = 1012
CLOSE_TRY_AGAIN_LATER = 1013


def encode(message: dict[str, Any]) -> str:
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False)


def ready(gap: bool) -> str:
    return encode({"type": "ready", "gap": gap})


def envelope(value: Envelope) -> str:
    return encode({"type": "envelope", "envelope": value.model_dump(mode="json")})


PONG = encode({"type": "pong"})
DEVICES_CHANGED = encode({"type": "devices_changed"})
