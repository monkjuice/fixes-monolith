---
title: In-memory rate limiter must evict in O(1)
type: gotcha
summary: "The bounded in-memory token-bucket table must evict in O(1): scanning every bucket on each new key let one IP flooding distinct keys stall the server's single event loop; buckets now live in an LRU-ordered OrderedDict."
tags: [v2, server, rate-limit, performance, dos, gotcha]
sources: []
updated: 2026-11-13
---

# In-memory rate limiter must evict in O(1)

Found in the `fixes-server/` code review (2026-11), now fixed.

## Pitfall

`TokenBucketLimiter` (`fixes-server/src/fixes_server/ratelimit.py`) keeps one bucket per key (IP, username, device…)
and caps the table at `DEFAULT_MAX_KEYS` (100 000). An earlier version scanned all buckets to evict whenever a new key
arrived: O(n) synchronous work on the event loop per request. One IP sending requests with distinct keys (e.g. new
usernames) could thus stall every request of the single API process.

## Rule (as of 2026-11-13)

Buckets are kept in an `OrderedDict` in last-use order (`move_to_end` on every touch). Eviction pops from the front with
`popitem(last=False)`: first buckets that have fully refilled (they carry no information), then the least recently
used ones while over the cap. `wait_time()` never creates a bucket, so requests refused by another limiter leave no
state. Any per-key in-memory structure on the request path needs the same bound and O(1) eviction, because the server
has one process and one event loop.

Related: [fixes-server](fixes-server.md), [v2 architecture](v2-architecture.md).
