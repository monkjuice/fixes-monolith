---
title: fixes-server (v2 server)
type: component
summary: "The v2 Python server, implemented (as of 2026-11-13): FastAPI src layout with a create_app(settings) factory, PyMongo AsyncMongoClient, local or S3 avatars, in-memory rate limits and WebSocket fan-out in one process, Docker Compose with optional s3 (MinIO) and tls (Caddy) profiles."
tags: [v2, server, python, fastapi, mongodb, component]
sources: []
updated: 2026-11-13
---

# fixes-server (v2 server)

Implements every endpoint of [`docs/protocol.md`](../../docs/protocol.md) rev 2.2 §5.3, the `/v1/ws` WebSocket (§6),
revocation and the idle sweep (§5.4), rate, size and concurrency limits (§5.6–5.7) and the MongoDB model (§11).
Structure **as of 2026-11-13**, per `fixes-server/README.md`, after code-review round 3. Verified 2026-11-13: 331
pytest tests pass, ruff and mypy clean, and the app's [e2e suite](run-e2e-suite.md) passes 18/18 against it with no
envelopes left.

## Layout (`fixes-server/src/fixes_server/`)

| Path | Role |
|---|---|
| `main.py` | `create_app(settings, hooks=...)` factory + lifespan; `app_from_env()` is the Uvicorn factory |
| `config.py` | `Settings` from `FIXES_*` env vars (pydantic-settings); no config files; fails fast |
| `context.py`, `deps.py` | `AppContext` (Mongo `AsyncMongoClient`, collections, worker limiter, services) on `app.state.ctx`; auth dependency |
| `routers/` | one module per API area: health, auth, devices, users, friends, envelopes, ws |
| `services/` | business logic: accounts, sessions, devices, identity, revocation, friends, envelopes, idle_sweep, ... |
| `security/` | argon2id, JWT access tokens, refresh tokens, X25519/Ed25519 validation |
| `realtime/` | WebSocket protocol and close codes, `ConnectionManager` (one bounded queue + writer task per socket), `RealtimeHooks` |
| `models/`, `errors.py` | Pydantic request/response bodies (§5.2); error envelope, 422 details capped at 20 fields ([gotcha](bounded-validation-errors.md)) |
| `middleware.py`, `ratelimit.py` | pure-ASGI body-size limit, large-body and envelope-page concurrency caps with slot deadlines ([gotcha](fastapi-parses-body-before-auth.md)); token buckets, `KeyedConcurrencyLimiter`, client-IP keys (IPv6 by /64) |
| `blocking.py`, `images.py`, `storage.py` | `run_blocking()` worker pool; avatar pipeline; local (`/media`) or S3 (boto3) storage |

## Design points

- **One process**: rate limits, sockets, fan-out and the per-device mailbox locks (`locks.py`) are in memory, so the
  caps are exact only within one Uvicorn worker. A restart closes sockets with 1012; clients reconnect and drain.
- **Hooks**: REST handlers call `ctx.hooks` (`hooks.py`; real implementation `realtime/hooks.py`) for envelope cleanup,
  socket close and `devices_changed`. Tests chain a `RecordingHooks` observer through `create_app(settings, hooks=...)`.
- No MongoDB transactions, worker threads, monotonic envelope ids: see [v2 architecture](v2-architecture.md).
- The lifespan runs the idle sweep at startup and hourly in an anyio task group.

## Deployment

`Dockerfile` + `docker-compose.yml`: API plus MongoDB on an internal network (never published, no auth). Profile `s3`
adds MinIO (objects readable only under `avatars/`, bucket not listable); profile `tls` adds Caddy at the fixed
address `172.30.0.10`, the only `FORWARDED_ALLOW_IPS` entry. As of 2026-11-13 neither file had been executed (no
Docker daemon on the dev machine; MinIO tags unverified). Behind Docker, IPv6 clients and host proxies can share the
gateway address for per-IP limits (see the README).

Run Uvicorn only behind the bundled Caddy (`tls` profile) or another HTTP reverse proxy, never exposed directly to
the internet: some resource-exhaustion cases (e.g. HTTP/1.1 pipelining clients that never read) are reachable only
with direct exposure ([gotcha](fastapi-parses-body-before-auth.md)).

## Tests

pytest, 331 tests as of 2026-11-13, against a real MongoDB: [Run the server tests](run-server-tests.md).
`scripts/e2e_server.py` launches a throwaway server for the app's [e2e suite](run-e2e-suite.md).

## Known limitations (README)

Single instance only; `gap` is reported once (lost if that response is lost); a MongoDB failure mid-batch can store a
prefix, and the retry stores duplicates that clients drop by message id; two simultaneous logins can both pass the
10-device cap; envelope batches (up to 9 MiB) are still parsed before the per-user rate limit, bounded by the
concurrency caps of protocol rev 2.2 §5.7 ([gotcha](fastapi-parses-body-before-auth.md)). After three review rounds
(40 → 9 → 4 issues) the remaining exposure is resource-exhaustion edge cases of a single-process server, listed under
the README's "Limitations".

Related: [fixes-app](fixes-app.md), [Run the server locally](run-server-locally.md),
[What the v2 server sees and keeps](v2-server-visibility.md); gotchas [JPEG scan bombs](jpeg-scan-bombs.md),
[rate-limiter eviction](rate-limiter-o1-eviction.md), [login vs password change](login-password-change-race.md),
[FastAPI parses the body before auth](fastapi-parses-body-before-auth.md),
[bounded 422 responses](bounded-validation-errors.md).
