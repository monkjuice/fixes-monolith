# FixesALL wiki — index

The catalog of this wiki: every page, grouped by type, one line each (`- [Title](path) — summary`). Conventions:
[SCHEMA.md](SCHEMA.md). History: [log.md](log.md).

## Overview

- [Overview](overview.md) — FixesALL at a glance: the Fixes private-chat app, its legacy .NET/Xamarin code and the v2 rewrite (protocol rev 2.2), implemented as fixes-server (FastAPI + MongoDB) and fixes-app (Expo SDK 57).

## Components

- [fixes-server (v2 server)](pages/fixes-server.md) — The v2 Python server, implemented (as of 2026-11-13): FastAPI src layout with a create_app(settings) factory, PyMongo AsyncMongoClient, local or S3 avatars, in-memory rate limits and WebSocket fan-out in one process, Docker Compose with optional s3 (MinIO) and tls (Caddy) profiles.
- [fixes-app (v2 app)](pages/fixes-app.md) — The v2 Expo SDK 57 (React Native 0.86) development-build app, implemented (as of 2026-11-13): pure-TypeScript src/core with injected platform services, Expo adapters in src/platform, React hooks in src/hooks, screens in src/ui, Node adapters and a FakeFixesServer in src/test-utils.
- [Legacy API (Fixes/)](pages/legacy-api.md) — The original .NET Core 3.1 backend: REST API, SignalR chat relay, SQL Server and Azure Blob avatars; reference only.
- [Legacy app (xamFixes/)](pages/legacy-app.md) — The original Xamarin.Forms app (Android, iOS) with per-user local SQLite history and RSA-based E2EE over SignalR; reference only.

## Concepts

- [What the v2 server sees and keeps](pages/v2-server-visibility.md) — Per protocol rev 2 §15: what the v2 server never sees, keeps transiently (ciphertext up to 30 days, plus oplog/snapshot copies), keeps persistently and exposes as metadata; operator duties.

## Decisions

- [v2 architecture](pages/v2-architecture.md) — Fixes v2 (protocol rev 2.2, implemented as of 2026-11-13): FastAPI + MongoDB relay server run as one process, Expo SDK 57 development-build app; messaging requires friendship; the server never stores conversations.
- [v2 account identity key](pages/v2-account-identity-key.md) — v2 trust model (protocol rev 2): a per-account Ed25519 identity key (AIK) certifies every device; new devices are linked by QR from a linked device, lost-all-devices users reset identity with the password; contacts pin the AIK.
- [v2 multi-device E2EE](pages/v2-multi-device-e2ee.md) — v2 message crypto (protocol rev 2): per-device X25519 keys, padded XChaCha20-Poly1305 envelopes fanned out to every certified device of both users, encrypted receipts, no forward secrecy.
- [v2 delivery reliability](pages/v2-delivery-reliability.md) — v2 sessions and delivery rules (protocol rev 2.2, implemented): atomic refresh rotation with 60 s retry grace, signed-out signals, 30-day idle device revocation, capped mailboxes with a gap flag, completeness check, server-time ordering, local outbox, receipt coalescing and hints, socket replacement and close codes.
- [v2 history transfer and backups](pages/v2-history-transfer-and-backups.md) — v2 ways to move device-only history (protocol rev 2): QR device linking that sends the identity key and history under an extra QR-secret layer, and recovery-key-encrypted backup files never uploaded to the server.
- [Collapsed undecryptable notices](pages/undecryptable-notices.md) — How fixes-app implements the protocol rev 2.2 §13 rule (one counting notice per run of undecryptable messages from a contact) with no schema change: the run lives in the notice row and a per-contact cursor makes each failure O(1); the count can be slightly off after a restart, and the lookup relies on message rows never being deleted or VACUUMed.
- [Expo SDK 57, not 58](pages/expo-sdk-57-pin.md) — fixes-app stays on Expo SDK 57 (React Native 0.86) because SDK 58 requires Node ≥ 22.13 and the dev machine has Node 20.19; expo-font and expo-asset are pinned as direct dependencies so npm does not resolve SDK 58 peers.

## Guides

- [Run the server locally](pages/run-server-locally.md) — Run fixes-server from a virtual environment (Python 3.12+, MongoDB 7+, FIXES_JWT_SECRET) with Uvicorn's --factory fixes_server.main:app_from_env, or with Docker Compose and its s3/tls profiles.
- [Run the server tests](pages/run-server-tests.md) — fixes-server checks: pytest (331 tests as of 2026-11-13) against any reachable mongod via FIXES_TEST_MONGODB_URI (default port 27099), plus ruff and mypy; tests fail rather than skip without MongoDB.
- [Run the app checks](pages/run-app-checks.md) — fixes-app checks that need no device or native toolchain: npx tsc --noEmit, npx expo lint, npx jest (core + app projects, 505 tests as of 2026-11-13) and npx expo export --platform android.
- [Run the e2e suite](pages/run-e2e-suite.md) — Run fixes-app/e2e (the real app core against a real fixes-server, 18 ordered tests) via fixes-server/scripts/e2e_server.py, which uses a throwaway database and fails the run if envelopes are left behind.
- [Make an app development build](pages/app-development-build.md) — Build the fixes-app dev client with npx expo prebuild --clean + npx expo run:android (or run:ios, or EAS Build), then iterate with Metro; Expo Go is unsupported because the app requires SQLCipher.

## Conventions

## Gotchas

- [Legacy defects](pages/legacy-defects.md) — Known breakages in the legacy API and app (58-char message limit, no offline delivery, missing hub methods, authorization holes) that v2 must not copy.
- [Expo defaults put app data in OS cloud backups](pages/expo-os-backups-leak-app-data.md) — Expo defaults (android.allowBackup true, keychain WHEN_UNLOCKED) silently copy app data such as a plaintext SQLite chat history to iCloud/Google backups; v2 uses SQLCipher, device-only keys and allowBackup false, which requires an Expo development build.
- [Safety codes use the device's own identity key](pages/safety-code-from-local-identity-key.md) — Compute your side of a safety code (and the 'Linked' check) from the AIK held on this phone, never the server's copy of your own key; otherwise a malicious server can make both users' codes match while it reads their messages.
- [Progressive-JPEG scan bombs](pages/jpeg-scan-bombs.md) — A valid ≤ 5 MiB progressive JPEG with ~100 000 scans keeps Pillow busy for minutes (each scan is a full pass; libjpeg sets no limit), so the avatar pipeline counts SOS markers and refuses more than 64 before decoding.
- [In-memory rate limiter must evict in O(1)](pages/rate-limiter-o1-eviction.md) — The bounded in-memory token-bucket table must evict in O(1): scanning every bucket on each new key let one IP flooding distinct keys stall the server's single event loop; buckets now live in an LRU-ordered OrderedDict.
- [Login racing a password change](pages/login-password-change-race.md) — A login whose slow argon2 check verified the old password could create a device that survived a concurrent password change; login re-checks the stored hash after creating the device and revokes it if the password changed.
- [Unit tests miss contract drift](pages/contract-drift-needs-e2e.md) — Server tests and app tests (against FakeFixesServer) each pass on their own reading of protocol.md; only the e2e suite against the real server catches drift (it found a stale cached device list dropping a reset contact's first message), and since it uses Node adapters, device-runtime drift such as an avatar upload expo/fetch cannot encode escapes it too.
- [Expo's global fetch (expo/fetch) pitfalls](pages/expo-fetch-pitfalls.md) — On iOS/Android Expo SDK 57 replaces the global fetch with expo/fetch, which cannot encode React Native {uri, name, type} FormData file parts (avatar upload failed on every real device while all tests passed) and resolves at the response headers with no read timeout, so the app's deadline must also cover the body read.
- [FastAPI parses the body before auth runs](pages/fastapi-parses-body-before-auth.md) — FastAPI parses a whole JSON body on the event loop before auth dependencies and per-user rate limits run, and tokens are free, so one account could OOM the single server process with 9 MiB pathological batches; ASGI middleware caps large bodies per account, parsing server-wide (with wait and send deadlines) and envelope pages per device (429), per protocol rev 2.2 §5.7.
- [422 responses must not grow with the body](pages/bounded-validation-errors.md) — Pydantic reports every unknown key and FastAPI builds all reports before the 422 handler, so a 9 MiB envelope batch of ~786k unknown keys cost seconds of event-loop time and produced a 34 MB 422 that a never-reading client could pin in memory; 422 details now list at most 20 fields (omitted_fields counts the rest) and batches with far too many keys are refused before validation (protocol rev 2.2 §5.1).
- [Windows development environment notes](pages/windows-dev-environment-notes.md) — On the Windows dev machine Uvicorn exits with code 3 after Ctrl+Break even on a clean shutdown, and NODE_TLS_REJECT_UNAUTHORIZED=0 is set globally (an insecure machine setting, not the project's).

## Sources

## Analyses
