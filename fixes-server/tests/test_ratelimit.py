from __future__ import annotations

import time

import pytest

from fixes_server.errors import ApiError
from fixes_server.ratelimit import (
    KeyedConcurrencyLimiter,
    TokenBucketLimiter,
    acquire_all,
    enforce,
    ip_limit_key,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_bucket_allows_capacity_then_waits() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(3, 60, clock=clock)
    assert [limiter.acquire("k") for _ in range(3)] == [0.0, 0.0, 0.0]
    assert limiter.acquire("k") == pytest.approx(20.0)
    assert limiter.acquire("other") == 0.0
    clock.now += 20
    assert limiter.acquire("k") == 0.0
    assert limiter.acquire("k") > 0


def test_refill_is_capped_at_capacity() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(2, 10, clock=clock)
    limiter.acquire("k")
    clock.now += 10_000
    assert [limiter.acquire("k") for _ in range(2)] == [0.0, 0.0]
    assert limiter.acquire("k") > 0


def test_refund_returns_a_token_but_not_beyond_capacity() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(1, 3600, clock=clock)
    assert limiter.acquire("k") == 0.0
    limiter.refund("k")
    limiter.refund("k")
    assert limiter.acquire("k") == 0.0
    assert limiter.acquire("k") > 0


def test_acquire_all_is_all_or_nothing() -> None:
    clock = FakeClock()
    roomy = TokenBucketLimiter(5, 60, clock=clock)
    tight = TokenBucketLimiter(1, 60, clock=clock)
    assert acquire_all((roomy, "a"), (tight, "b")) == 0.0
    assert acquire_all((roomy, "a"), (tight, "b")) == pytest.approx(60.0)
    # The failed attempt did not take a token from the roomy bucket.
    assert [roomy.acquire("a") for _ in range(4)] == [0.0] * 4
    assert roomy.acquire("a") > 0


def test_enforce_raises_429_with_retry_after() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(1, 90, clock=clock)
    enforce((limiter, "k"))
    with pytest.raises(ApiError) as excinfo:
        enforce((limiter, "k"))
    error = excinfo.value
    assert error.status_code == 429
    assert error.code == "rate_limited"
    assert error.headers is not None
    assert error.headers["Retry-After"] == "90"
    clock.now += 89.5
    with pytest.raises(ApiError) as excinfo:
        enforce((limiter, "k"))
    assert excinfo.value.headers is not None
    assert excinfo.value.headers["Retry-After"] == "1"  # Rounded up, never 0.


def test_memory_is_bounded() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(1, 60, clock=clock, max_keys=100)
    for i in range(1000):
        limiter.acquire(i)
    assert len(limiter._buckets) <= 100
    # The most recent keys are still limited.
    assert limiter.acquire(999) > 0


def test_new_keys_past_the_cap_cost_constant_time() -> None:
    """Once the table is full, every new key evicts one bucket; that must not mean a scan
    of all buckets on the event loop (a flood of distinct usernames would stall it)."""
    clock = FakeClock()
    limiter = TokenBucketLimiter(10, 900, clock=clock, max_keys=50_000)
    for key in range(50_000):
        assert limiter.acquire(key) == 0.0
    started = time.perf_counter()
    for key in range(50_000, 52_000):
        assert limiter.acquire(key) == 0.0
    elapsed = time.perf_counter() - started
    assert len(limiter._buckets) == 50_000
    assert elapsed < 1.0, f"2000 evictions took {elapsed:.2f}s"


def test_eviction_drops_refilled_buckets_then_least_recently_used() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(1, 60, clock=clock, max_keys=3)
    for key in ("a", "b", "c"):
        assert limiter.acquire(key) == 0.0
        clock.now += 1
    assert limiter.acquire("a") > 0  # refused, but a use: "a" is now the most recent key
    assert limiter.acquire("d") == 0.0
    # Over the cap and nothing has refilled: the least recently used key goes.
    assert list(limiter._buckets) == ["c", "a", "d"]
    assert limiter.acquire("a") > 0
    # Buckets that have refilled completely carry no information; all of them go first.
    clock.now += 60
    assert limiter.acquire("e") == 0.0
    assert list(limiter._buckets) == ["e"]


def test_refused_requests_create_no_buckets() -> None:
    """A request refused by one limiter must not create state in the others: otherwise a
    client already over its per-IP limit could still fill the (username, IP) table."""
    clock = FakeClock()
    per_user_ip = TokenBucketLimiter(10, 900, clock=clock)
    per_ip = TokenBucketLimiter(1, 3600, clock=clock)
    enforce((per_user_ip, ("first", "ip")), (per_ip, "ip"))
    for i in range(100):
        with pytest.raises(ApiError):
            enforce((per_user_ip, (f"user{i}", "ip")), (per_ip, "ip"))
    assert len(per_user_ip._buckets) == 1
    assert per_user_ip.wait_time(("unseen", "ip")) == 0.0
    assert len(per_user_ip._buckets) == 1


@pytest.mark.parametrize(
    ("address", "key"),
    [
        ("203.0.113.7", "203.0.113.7"),
        ("::ffff:203.0.113.7", "203.0.113.7"),
        ("2001:db8::1", "2001:db8::/64"),
        ("2001:db8::ffff:1", "2001:db8::/64"),
        ("2001:DB8:0:0:abcd::1", "2001:db8::/64"),
        ("2001:db8:0:1::1", "2001:db8:0:1::/64"),
        ("fe80::1%eth0", "fe80::/64"),
        ("testclient", "testclient"),
        ("unknown", "unknown"),
    ],
)
def test_ip_limit_key(address: str, key: str) -> None:
    assert ip_limit_key(address) == key


def test_invalid_configuration() -> None:
    with pytest.raises(ValueError, match="capacity"):
        TokenBucketLimiter(0, 60)
    with pytest.raises(ValueError, match="period"):
        TokenBucketLimiter(1, 0)


def test_concurrency_limiter() -> None:
    limiter = KeyedConcurrencyLimiter(2)
    assert limiter.try_enter("ip")
    assert limiter.try_enter("ip")
    assert not limiter.try_enter("ip")
    assert limiter.try_enter("other")
    limiter.leave("ip")
    assert limiter.try_enter("ip")
    limiter.leave("ip")
    limiter.leave("ip")
    limiter.leave("ip")  # Extra leaves are harmless.
    assert limiter._active == {"other": 1}
