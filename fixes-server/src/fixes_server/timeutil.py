"""UTC time helpers. MongoDB stores milliseconds, so every timestamp is truncated to them."""

from __future__ import annotations

from datetime import UTC, datetime


def utcnow() -> datetime:
    now = datetime.now(UTC)
    # Truncate up front so values compare equal before and after a MongoDB round trip.
    return now.replace(microsecond=now.microsecond - now.microsecond % 1000)


def as_utc(value: datetime) -> datetime:
    """Interpret naive datetimes as UTC (PyMongo returns aware ones when ``tz_aware=True``)."""
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def isoformat_utc(value: datetime) -> str:
    """ISO 8601 with milliseconds and a ``Z`` suffix, as required by protocol §3."""
    return as_utc(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")
