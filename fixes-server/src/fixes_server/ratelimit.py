"""In-memory token-bucket rate limiting (protocol §5.6).

State lives in this process only, which is why the server must run as a single instance.
All methods are synchronous and are called from the event loop thread, so no locking is
needed: there is no ``await`` between checking and taking a token.
"""

from __future__ import annotations

import ipaddress
import math
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable
from dataclasses import dataclass

from starlette.requests import HTTPConnection

from fixes_server.config import RateLimit, Settings
from fixes_server.errors import rate_limited

Clock = Callable[[], float]
DEFAULT_MAX_KEYS = 100_000


@dataclass(slots=True)
class _Bucket:
    tokens: float
    updated_at: float


class TokenBucketLimiter:
    """``capacity`` tokens per key, refilled continuously at ``capacity / period`` per second."""

    def __init__(
        self,
        capacity: int,
        period_seconds: float,
        *,
        clock: Clock = time.monotonic,
        max_keys: int = DEFAULT_MAX_KEYS,
    ) -> None:
        if capacity < 1 or period_seconds <= 0:
            raise ValueError("capacity must be >= 1 and period_seconds > 0")
        self.capacity = capacity
        self.period_seconds = period_seconds
        self._rate = capacity / period_seconds
        self._clock = clock
        self._max_keys = max_keys
        self._buckets: OrderedDict[Hashable, _Bucket] = OrderedDict()

    @classmethod
    def from_setting(cls, limit: RateLimit, *, clock: Clock = time.monotonic) -> TokenBucketLimiter:
        return cls(limit.capacity, limit.period_seconds, clock=clock)

    def wait_time(self, key: Hashable) -> float:
        """Seconds until a token is available for ``key`` (0 if one is available now).

        Asking never creates a bucket (an unknown key has a full one), so requests refused
        by another limiter leave no state behind; only :meth:`take` creates buckets.
        """
        if key not in self._buckets:
            return 0.0
        bucket = self._refill(key, self._clock())
        if bucket.tokens >= 1:
            return 0.0
        return (1 - bucket.tokens) / self._rate

    def take(self, key: Hashable) -> None:
        """Consume a token; callers check :meth:`wait_time` first (see :func:`acquire_all`)."""
        bucket = self._refill(key, self._clock())
        bucket.tokens -= 1

    def acquire(self, key: Hashable) -> float:
        """Take a token if possible. Returns 0 on success, else the seconds to wait."""
        wait = self.wait_time(key)
        if wait == 0:
            self.take(key)
        return wait

    def refund(self, key: Hashable) -> None:
        """Give a token back (e.g. a login attempt turned out not to be a failure)."""
        bucket = self._refill(key, self._clock())
        bucket.tokens = min(self.capacity, bucket.tokens + 1)

    def _refill(self, key: Hashable, now: float) -> _Bucket:
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _Bucket(tokens=float(self.capacity), updated_at=now)
            self._buckets[key] = bucket
            self._evict_if_needed(now)
        else:
            elapsed = max(0.0, now - bucket.updated_at)
            bucket.tokens = min(float(self.capacity), bucket.tokens + elapsed * self._rate)
            bucket.updated_at = now
            self._buckets.move_to_end(key)
        return bucket

    def _evict_if_needed(self, now: float) -> None:
        if len(self._buckets) <= self._max_keys:
            return
        # Every touch moves a bucket to the end, so the dict is ordered by updated_at and the
        # oldest buckets are at the front: eviction never needs to scan the whole table
        # (which, under a flood of distinct keys, would cost O(n) per new key).
        # Buckets that have refilled completely carry no information; drop those first.
        full_after = self.capacity / self._rate
        while self._buckets:
            oldest = next(iter(self._buckets.values()))
            if now - oldest.updated_at < full_after:
                break
            self._buckets.popitem(last=False)
        # Under a flood of distinct keys, bound memory by forgetting the least recently used.
        while len(self._buckets) > self._max_keys:
            self._buckets.popitem(last=False)


def acquire_all(*checks: tuple[TokenBucketLimiter, Hashable]) -> float:
    """Take one token from every (limiter, key) pair, or none at all.

    Returns 0 on success, else the longest wait among the exhausted buckets. A refused
    request creates no bucket in any of the limiters.
    """
    wait = max((limiter.wait_time(key) for limiter, key in checks), default=0.0)
    if wait > 0:
        return wait
    for limiter, key in checks:
        limiter.take(key)
    return 0.0


def enforce(*checks: tuple[TokenBucketLimiter, Hashable]) -> None:
    """Take a token from each pair or raise 429 ``rate_limited`` with ``Retry-After``."""
    wait = acquire_all(*checks)
    if wait > 0:
        raise rate_limited(max(1, math.ceil(wait)))


class KeyedConcurrencyLimiter:
    """Caps simultaneous holders per key (e.g. unauthenticated WebSockets per IP)."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self._active: dict[Hashable, int] = {}

    def try_enter(self, key: Hashable) -> bool:
        current = self._active.get(key, 0)
        if current >= self.limit:
            return False
        self._active[key] = current + 1
        return True

    def leave(self, key: Hashable) -> None:
        current = self._active.get(key, 0)
        if current <= 1:
            self._active.pop(key, None)
        else:
            self._active[key] = current - 1


@dataclass(frozen=True, slots=True)
class RateLimiters:
    """Every limit of §5.6, built from settings."""

    register: TokenBucketLimiter
    login_failures_user_ip: TokenBucketLimiter
    login_failures_ip: TokenBucketLimiter
    login_success: TokenBucketLimiter
    refresh: TokenBucketLimiter
    envelopes: TokenBucketLimiter
    user_lookup: TokenBucketLimiter
    friend_requests: TokenBucketLimiter
    avatar: TokenBucketLimiter
    ws_connect: TokenBucketLimiter
    ws_unauthenticated: KeyedConcurrencyLimiter

    @classmethod
    def from_settings(cls, settings: Settings, *, clock: Clock = time.monotonic) -> RateLimiters:
        def bucket(limit: RateLimit) -> TokenBucketLimiter:
            return TokenBucketLimiter.from_setting(limit, clock=clock)

        return cls(
            register=bucket(settings.rate_limit_register),
            login_failures_user_ip=bucket(settings.rate_limit_login_failures_user_ip),
            login_failures_ip=bucket(settings.rate_limit_login_failures_ip),
            login_success=bucket(settings.rate_limit_login_success),
            refresh=bucket(settings.rate_limit_refresh),
            envelopes=bucket(settings.rate_limit_envelopes),
            user_lookup=bucket(settings.rate_limit_user_lookup),
            friend_requests=bucket(settings.rate_limit_friend_requests),
            avatar=bucket(settings.rate_limit_avatar),
            ws_connect=bucket(settings.rate_limit_ws_connect),
            ws_unauthenticated=KeyedConcurrencyLimiter(settings.ws_max_unauthenticated_per_ip),
        )


def client_ip(connection: HTTPConnection) -> str:
    """The socket peer, which Uvicorn rewrites to the forwarded client only for trusted proxies.

    Forwarding headers are deliberately not parsed here: trusting them is Uvicorn's job
    (``--proxy-headers`` plus ``FORWARDED_ALLOW_IPS``), so clients cannot spoof their IP.
    """
    return connection.client.host if connection.client else "unknown"


# One IPv6 subscriber (a home line, a VPS) is routed a whole /64, so per-IP limits keyed by
# the full address could be dodged by rotating through 2**64 source addresses.
IPV6_LIMIT_PREFIX = 64


def ip_limit_key(address: str) -> str:
    """The key per-IP limits use for ``address``: IPv4 addresses as they are (IPv4-mapped
    IPv6 included), other IPv6 addresses by their /64; anything unparsable unchanged."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return address
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        network = ipaddress.IPv6Network((int(ip), IPV6_LIMIT_PREFIX), strict=False)
        return str(network)
    return str(ip)


def client_ip_key(connection: HTTPConnection) -> str:
    """The client's per-IP rate-limit key (see :func:`ip_limit_key`)."""
    return ip_limit_key(client_ip(connection))
