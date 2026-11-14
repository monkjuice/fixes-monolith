---
title: v2 architecture
type: decision
summary: "Fixes v2 (protocol rev 2.2, implemented as of 2026-11-13): FastAPI + MongoDB relay server run as one process, Expo SDK 57 development-build app; messaging requires friendship; the server never stores conversations."
tags: [v2, architecture, decision, python, react-native, mongodb, abuse-limits]
sources: []
updated: 2026-11-13
---

# v2 architecture

**Status: per [`docs/protocol.md`](../../docs/protocol.md) rev 2.2; implemented as of 2026-11-13** in
[fixes-server](fixes-server.md) and [fixes-app](fixes-app.md) (three code-review rounds applied, 40 → 9 → 4 issues;
the app side of the rev 2.2 §13 notice rule completed and verified on 2026-11-13). Rev 2 followed an adversarial design review;
rev 2.1 added clarifications from implementation and code review; rev 2.2 added capped 422 details (§5.1), the
concurrency caps (§5.7) and collapsed undecryptable-message notices (§13). The document is the server/app contract:
change it first when the contract changes.

## Context

The [Legacy API](legacy-api.md) and [Legacy app](legacy-app.md) depend on Azure-specific services, run on
out-of-support frameworks (.NET Core 3.1, Xamarin) and never worked end to end ([Legacy defects](legacy-defects.md)).

## Choices

- **Server `fixes-server/`**: Python 3.12+, FastAPI, Pydantic v2, PyMongo's async API (`AsyncMongoClient`; Motor is
  deprecated), argon2-cffi, PyJWT, `cryptography` (validates Ed25519 certificates and X25519 keys), Pillow.
- **Store**: MongoDB 7+, standalone server supported, so **no multi-document transactions**: multi-step writes use
  crash-safe orders (as implemented: refresh rotation stores the successor before consuming the old token; friendship
  inserted with `_id = pair_key`, then the request deleted; avatar uploaded before the user points at it; envelope
  batches set `overflow_at` before inserting; password changes revoke other devices before and after the hash write;
  revocation steps idempotent, so a later refresh, revocation or idle sweep finishes an interrupted one). Avatars on
  the local filesystem or any S3-compatible bucket (public-read or CDN, never presigned). Env vars; Docker Compose with
  optional MinIO and Caddy TLS profiles.
- **Envelope ids** are ObjectId hex strings that strictly increase within the process (`MonotonicObjectIds`), so
  mailbox pages (`GET /v1/envelopes`, id order) follow storage order.
- **App `fixes-app/`**: Expo SDK 57 / React Native 0.86 (TypeScript) **development build**, not Expo Go, because
  SQLCipher needs native config ([Expo OS backups gotcha](expo-os-backups-leak-app-data.md)); SDK 58 was skipped for
  Node reasons ([Expo SDK 57, not 58](expo-sdk-57-pin.md)). One SQLCipher DB per user. Platform-free core with
  injected services, so the same code runs under Jest and the e2e suite.
- **Relay only**: envelopes are deleted on ack or after 30 days; see
  [what the server sees and keeps](v2-server-visibility.md).
- **Messaging requires friendship**: the server rejects envelopes to non-friends (403 `not_friends`); the profile shows
  "Add friend" until accepted. Legacy allowed messaging anyone from their profile; v2 forbids it against spam and
  mailbox-flooding DoS.
- Production is HTTPS/WSS only; release builds refuse a non-`https` API URL.
- Product parity with legacy screens is tabulated in protocol §14 (tabs Messages/Discover/Profile; Home/New Post and
  the debug "Copiar BDD" button dropped; Settings adds Devices, Link a new device, Backups, Erase this device).

## Server rules

- Run exactly **one** API process: WebSocket fan-out and rate limits live in memory. Put it behind the bundled Caddy
  or another HTTP reverse proxy, never directly on the internet (as recommended after code-review round 3).
- argon2, Pillow and boto3 run in worker threads (`anyio.to_thread.run_sync`, `CapacityLimiter(4)`), never directly in
  async handlers. argon2id parameters are pinned (`time_cost=3, memory_cost=65536, parallelism=1`; rehash on change).
- **Abuse limits**: token-bucket rate limits per IP/user/device (table in §5.6), checked before any password hashing;
  rev 2.1 adds successful password checks (login, password change, identity reset) 30/hour/username, since correct
  passwords still cost argon2 time and every login stores a device. Size limits by ASGI middleware on `Content-Length`
  and streamed bytes (§5.7; WebSocket frames 64 KiB; the 9 MiB / 5.5 MiB budgets only for verified access tokens),
  plus concurrency caps on large bodies and envelope pages (§5.7 since rev 2.2,
  [gotcha](fastapi-parses-body-before-auth.md)) and 422 details capped at 20 fields
  ([gotcha](bounded-validation-errors.md)); envelope ciphertext 16 bytes (the Poly1305 tag) to 65 536. The
  avatar pipeline guards against decompression bombs (format allow-list, header size check before decoding,
  `MAX_IMAGE_PIXELS`, `DecompressionBombWarning` as error) and [JPEG scan bombs](jpeg-scan-bombs.md).
- Client IP = socket peer unless Uvicorn runs with `--proxy-headers` and `FORWARDED_ALLOW_IPS` set to the proxy;
  without that, behind a proxy every client shares the proxy's IP buckets. IPv6 clients are keyed by their /64
  (IPv4-mapped addresses count as IPv4). See also [rate-limiter eviction](rate-limiter-o1-eviction.md).
- Rev 2.1 error codes: 405 `method_not_allowed` (with `Allow`), 503 `service_unavailable` (only `/healthz`, when MongoDB
  is unreachable).

## Rejected or deferred

- Multi-instance deployment: needs a pub/sub broker and shared rate limiting (follow-up).
- Non-goals: forward secrecy, group chats, sealed sender, attachments, posts/feed, push notifications, migration of
  legacy accounts or databases (users re-register).

## Consequences

- History cannot be recovered from the server; it moves only via
  [device linking or backups](v2-history-transfer-and-backups.md).
- Server tests need a reachable MongoDB instance ([Run the server tests](run-server-tests.md)); contract agreement
  between the two sides is only checked by the [e2e suite](run-e2e-suite.md)
  ([why](contract-drift-needs-e2e.md)).

Related: [v2 account identity key](v2-account-identity-key.md), [v2 multi-device E2EE](v2-multi-device-e2ee.md),
[v2 delivery reliability](v2-delivery-reliability.md).
