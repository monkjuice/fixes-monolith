"""Bodies of the envelope relay endpoints (protocol §5.3 Envelopes)."""

from __future__ import annotations

from itertools import islice
from typing import Annotated, Any

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    Field,
    StringConstraints,
    WithJsonSchema,
)

from fixes_server.encoding import decode_base64
from fixes_server.ids import ENVELOPE_ID_PATTERN
from fixes_server.models.common import Envelope, RequestModel, UtcDateTime, Uuid

NONCE_BYTES = 24
# XChaCha20-Poly1305 output always carries a 16-byte tag, so anything shorter is not a
# ciphertext. The upper bound (65 536) is checked by the service: it answers 413, not 422.
MIN_CIPHERTEXT_BYTES = 16
MAX_CIPHERTEXT_BYTES = 65_536
MAX_BATCH_ENVELOPES = 100
MAX_COMPLETE_FOR_USERS = 2
MAX_ACK_IDS = 500
DEFAULT_FETCH_LIMIT = 100
MAX_FETCH_LIMIT = 500
# Unknown keys a batch object may have and still be validated, each named in the 422; an
# object with more is refused whole (see has_too_many_keys).
MAX_UNKNOWN_KEYS = 10


def _decode(value: Any) -> bytes:
    # ValueError, not TypeError: pydantic turns only ValueError into a validation error (422).
    if not isinstance(value, str):
        raise ValueError("must be a standard base64 string")
    return decode_base64(value)


def _check_nonce(raw: bytes) -> bytes:
    if len(raw) != NONCE_BYTES:
        raise ValueError(f"must decode to exactly {NONCE_BYTES} bytes")
    return raw


def _check_ciphertext(raw: bytes) -> bytes:
    if len(raw) < MIN_CIPHERTEXT_BYTES:
        raise ValueError(f"must decode to at least {MIN_CIPHERTEXT_BYTES} bytes")
    return raw


# Decoded during validation so the service works on bytes and a large ciphertext is decoded
# once; the JSON schema still documents the wire format (base64 strings).
_BASE64_SCHEMA = WithJsonSchema({"type": "string", "format": "byte"})
NonceBytes = Annotated[
    bytes, BeforeValidator(_decode), AfterValidator(_check_nonce), _BASE64_SCHEMA
]
CiphertextBytes = Annotated[
    bytes, BeforeValidator(_decode), AfterValidator(_check_ciphertext), _BASE64_SCHEMA
]
EnvelopeId = Annotated[str, StringConstraints(pattern=ENVELOPE_ID_PATTERN)]


class OutgoingEnvelope(RequestModel):
    """One envelope of a batch. There is deliberately no sender field: it comes from the token."""

    recipient_device_id: Uuid
    nonce: NonceBytes
    ciphertext: CiphertextBytes


class SendEnvelopesRequest(RequestModel):
    envelopes: list[OutgoingEnvelope] = Field(min_length=1, max_length=MAX_BATCH_ENVELOPES)
    complete_for_user_ids: list[Uuid] = Field(
        default_factory=list, max_length=MAX_COMPLETE_FOR_USERS
    )


def has_too_many_keys(batch: Any) -> bool:
    """Whether a decoded ``POST /v1/envelopes`` body has an object with more than
    ``MAX_UNKNOWN_KEYS`` keys beyond the fields of its model.

    Such a body is invalid anyway (the models forbid unknown fields), but pydantic reports each
    unknown key, and FastAPI builds every report before the 422 handler runs: 9 MiB of unknown
    keys would become about 800 000 errors, 1 GB and seconds of event-loop time. Only the
    objects pydantic would look at are checked: the batch and its first
    ``MAX_BATCH_ENVELOPES + 1`` envelopes (it stops at the next one with one ``too_long``).
    """
    if _too_many_keys(batch, SendEnvelopesRequest):
        return True
    envelopes = batch.get("envelopes") if isinstance(batch, dict) else None
    if not isinstance(envelopes, list):
        return False
    return any(
        _too_many_keys(envelope, OutgoingEnvelope)
        for envelope in islice(envelopes, MAX_BATCH_ENVELOPES + 1)
    )


def _too_many_keys(value: Any, model: type[BaseModel]) -> bool:
    return isinstance(value, dict) and len(value) > len(model.model_fields) + MAX_UNKNOWN_KEYS


class SendEnvelopesResponse(BaseModel):
    ids: list[str | None]
    created_at: UtcDateTime
    dropped_device_ids: list[str]


class EnvelopeList(BaseModel):
    envelopes: list[Envelope]
    gap: bool


class AckRequest(RequestModel):
    ids: list[EnvelopeId] = Field(min_length=1, max_length=MAX_ACK_IDS)
