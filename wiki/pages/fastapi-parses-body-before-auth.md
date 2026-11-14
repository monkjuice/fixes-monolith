---
title: FastAPI parses the body before auth runs
type: gotcha
summary: "FastAPI parses a whole JSON body on the event loop before auth dependencies and per-user rate limits run, and tokens are free, so one account could OOM the single server process with 9 MiB pathological batches; ASGI middleware caps large bodies per account, parsing server-wide (with wait and send deadlines) and envelope pages per device (429), per protocol rev 2.2 §5.7."
tags: [v2, server, fastapi, security, abuse-limits, gotcha]
sources: []
updated: 2026-11-13
---

# FastAPI parses the body before auth runs

Found by code-review round 2 (2026-11); deadlines added in round 3; fixed as of 2026-11-13.

## Pitfall

FastAPI reads and parses a JSON body completely, on the event loop, before the route's dependencies (auth, per-user
rate limits) run. A pathological 9 MiB batch such as `{"envelopes":[{},{},...]}` becomes ~250 MB of Python objects
held until the request ends. The size middleware grants the 9 MiB / 5.5 MiB limits only to requests whose access
token verifies, but registration is free, so a valid token bounds nothing: one account sending such bodies in
parallel could OOM the single process.

## Fix (`fixes-server/src/fixes_server/middleware.py`)

Pure-ASGI guards that act before any body byte is read; refusals are 429 `rate_limited` with `Retry-After: 1`.

- `BodySizeLimitMiddleware`: at most 4 `POST /v1/envelopes` or avatar uploads in flight per account; an envelope
  batch over 64 KiB is read whole, then waits for one of 2 server-wide parsing slots.
- **Slot deadlines (round 3)**: slots without deadlines could be pinned by an HTTP/1.1 client that pipelines requests
  and never reads the responses. Now a batch waiting over `LARGE_JSON_WAIT_SECONDS` (10 s, below the app's 30 s request
  timeout) gets the 429, and a slot holder whose client leaves a response part unread for `SLOT_SEND_TIMEOUT_SECONDS`
  (5 s) is abandoned and the slot freed.
- `EnvelopePageMiddleware`: at most 2 `GET /v1/envelopes` pages in flight per device; a page (up to ~5.6 MB of JSON)
  is sent in 64 KiB pieces paced by the client's reading and abandoned after 30 s without reading.
- Abandoned responses make Uvicorn log `ASGI callable returned without starting/completing response.` at ERROR; that
  is expected.

The caps assume the app's behaviour (one batch and one page at a time per device). Since protocol rev 2.2 they are
part of the contract (`docs/protocol.md` §5.7 "Concurrency caps"). Bodies full of unknown keys are refused before
validation: see [422 responses must not grow with the body](bounded-validation-errors.md).

## Remaining exposure

Resource-exhaustion edge cases of a single-process server, listed under "Limitations" in `fixes-server/README.md`
(~0.3 s event-loop stall per pathological batch; stalling connections can delay others' large batches up to the 10 s
wait; ~110 MB of pages per slow-reading account). The pipelining case is reachable only when Uvicorn is exposed
directly: run it behind the bundled Caddy (`tls` profile) or another HTTP reverse proxy, never directly on the internet.

## Rule

Bound every large-body route in ASGI middleware before the body is parsed, and give every shared slot a deadline;
FastAPI dependencies run too late.

Related: [fixes-server](fixes-server.md), [v2 architecture](v2-architecture.md),
[In-memory rate limiter must evict in O(1)](rate-limiter-o1-eviction.md), [JPEG scan bombs](jpeg-scan-bombs.md).
