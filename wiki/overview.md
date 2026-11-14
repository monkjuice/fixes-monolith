---
title: Overview
type: overview
summary: "FixesALL at a glance: the Fixes private-chat app, its legacy .NET/Xamarin code and the v2 rewrite (protocol rev 2.2), implemented as fixes-server (FastAPI + MongoDB) and fixes-app (Expo SDK 57)."
tags: [overview]
sources: []
updated: 2026-11-13
---

# FixesALL

## What it does

Fixes is a privacy-focused social app: accounts, profiles with an avatar, user search, friendships and an end-to-end
encrypted (E2EE) 1:1 chat whose history lives only on the users' devices, never on the server.

## Architecture

The repository holds two generations:

| Folder | What | Status |
|---|---|---|
| `Fixes/` | Legacy .NET Core 3.1 API, see [Legacy API](pages/legacy-api.md) | Kept untouched as reference |
| `xamFixes/` | Legacy Xamarin.Forms app (Android, iOS), see [Legacy app](pages/legacy-app.md) | Kept untouched as reference |
| `docs/protocol.md` | Contract for **Fixes v2** ([`docs/protocol.md`](../docs/protocol.md)) | Revision 2.2 (design review, then implementation and three code-review rounds) |
| `fixes-server/` | v2 server, see [fixes-server](pages/fixes-server.md) | Implemented (three code-review rounds applied); verified 2026-11-13: 331 tests pass, ruff/mypy clean |
| `fixes-app/` | v2 app, see [fixes-app](pages/fixes-app.md) | Implemented (three code-review rounds applied, rev 2.2 §13 notice rule included); verified 2026-11-13: 505 tests pass, tsc/lint clean, Android bundle builds; e2e 18/18 against the real server, 0 envelopes left |

The legacy code never fully worked (offline delivery, receipts, 58-character message limit): see
[Legacy defects](pages/legacy-defects.md).

**Licence**: none chosen yet. The legacy code has none, and the MIT `LICENSE` from the Expo template (naming Expo's
company as copyright holder) was removed from `fixes-app/`; the owner should pick one.

**Fixes v2** (per `docs/protocol.md` rev 2.2):

- [v2 architecture](pages/v2-architecture.md): single-process Python/FastAPI + MongoDB server that only relays opaque
  envelopes, Expo development-build app with a per-user SQLCipher database; messaging only between friends.
- [v2 account identity key](pages/v2-account-identity-key.md): a per-account Ed25519 key certifies every device; new
  devices are linked by QR from a linked device.
- [v2 multi-device E2EE](pages/v2-multi-device-e2ee.md): per-device X25519 keys, XChaCha20-Poly1305 envelopes fanned
  out to every certified device.
- [v2 delivery reliability](pages/v2-delivery-reliability.md): refresh-token rotation, idle revocation, mailbox caps,
  outbox, receipt and socket rules.
- [v2 history transfer and backups](pages/v2-history-transfer-and-backups.md): history sent during QR linking, and
  recovery-key-encrypted backup files that never reach the server.
- [What the v2 server sees and keeps](pages/v2-server-visibility.md), [Expo SDK 57, not 58](pages/expo-sdk-57-pin.md)
  and the gotchas listed in [index.md](index.md).

## Tech stack

- Legacy: ASP.NET Core 3.1, EF Core + SQL Server, SignalR, JWT, Azure Blob Storage; Xamarin.Forms, sqlite-net, RSA.
- v2: Python 3.12+, FastAPI, PyMongo async (`AsyncMongoClient`), MongoDB 7+, local or S3-compatible avatar storage,
  Docker Compose (optional MinIO and Caddy TLS profiles); Expo SDK 57 / React Native 0.86 (TypeScript) development
  build, React Navigation, expo-sqlite with SQLCipher, expo-secure-store, `@noble/*` crypto; Jest and pytest.

## Build, run and test

- Legacy: `Fixes/Fixes.sln` and `xamFixes/xamFixes.sln` (Visual Studio). The API reads `DefaultConnection` (SQL
  Server) and `AzureStorage` from a `ConnectionStrings.config` that is not in the repository; the app hard-codes its
  API URL in `xamFixes/xamFixes/Services/Base.cs`.
- v2 server: [Run the server locally](pages/run-server-locally.md), [Run the server tests](pages/run-server-tests.md)
  (needs a reachable MongoDB).
- v2 app: [Run the app checks](pages/run-app-checks.md), [Make an app development build](pages/app-development-build.md)
  (Expo Go is not supported).
- Both together: [Run the e2e suite](pages/run-e2e-suite.md).

## Where to start reading

[`docs/protocol.md`](../docs/protocol.md) for v2, then the decision pages above and the two component pages; the
legacy pages only for reference.
