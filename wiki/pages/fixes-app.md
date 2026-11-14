---
title: fixes-app (v2 app)
type: component
summary: "The v2 Expo SDK 57 (React Native 0.86) development-build app, implemented (as of 2026-11-13): pure-TypeScript src/core with injected platform services, Expo adapters in src/platform, React hooks in src/hooks, screens in src/ui, Node adapters and a FakeFixesServer in src/test-utils."
tags: [v2, app, expo, react-native, typescript, component]
sources: []
updated: 2026-11-13
---

# fixes-app (v2 app)

Client side of [`docs/protocol.md`](../../docs/protocol.md) rev 2.2 and every §14 screen. Structure **as of
2026-11-13**, per `fixes-app/README.md`, after code-review round 3 and the rev 2.2 §13 rule collapsing undecryptable
notices ([Collapsed undecryptable notices](undecryptable-notices.md)). Verified 2026-11-13: 505 jest tests pass, `tsc`
and lint clean, the Android bundle builds, and the [e2e suite](run-e2e-suite.md) passes 18/18 against the real server
with no envelopes left.

## Layout

| Path | Role |
|---|---|
| `index.ts` | imports `react-native-get-random-values` first, then registers `App` |
| `src/core/` | pure TypeScript: `crypto`, `api` (`ApiClient`, single-flight `TokenManager`), `realtime` (`RealtimeSocket`), `db` (schema, migrations, `LocalStore`, repositories, live queries), `session` (`SessionManager`), `payloads`, `trust` (`DeviceDirectory`), `messaging` (`MessagingEngine`), `linking`, `snapshot`, `backup` |
| `src/core/platform.ts` | injected service interfaces: `SqlDatabase`, `DatabaseOpener`, `SecureKeyValueStore`, `WebSocketFactory`, `HttpUpload`, `FileAdapter`, `Clock`, `FetchLike` |
| `src/platform/` | Expo implementations (expo-sqlite with SQLCipher, device-only expo-secure-store, expo-file-system/sharing/document-picker) and `getAppServices()` |
| `src/hooks/` | `FixesProvider` and data hooks over `useSyncExternalStore` |
| `src/ui/` | `FixesApp`, navigation (root stack switched by session status), screens, components, pure `presentation/` logic |
| `src/test-utils/` | Node adapters (better-sqlite3, in-memory secure store, `ws`), `FakeFixesServer`, `createTestPhone()` |
| `e2e/` | suite against the real server ([Run the e2e suite](run-e2e-suite.md)) |

## Rules (enforced by `eslint.config.js`)

- `src/core` imports nothing from `src/platform`, `src/test-utils` or React/RN/Expo; `src/ui` gets services only via
  `FixesProvider`, never `src/platform`; only tests import `src/test-utils`.
- Randomness only from `crypto.getRandomValues` (`core/crypto/random.ts`), never `Math.random`.
- `LocalStore` serialises everything on one connection: inside `store.transaction(async (tx) => …)` use only `tx`;
  using `store` there deadlocks.
- Not lint-enforced: message rows are never deleted and the database is never `VACUUM`ed, because the undecryptable
  notice lookup relies on growing rowids ([gotcha](undecryptable-notices.md)).

## Runtime shape

`SessionManager` (`loading | signedOut | needsLink | ready`) drives `MessagingEngine`: *linking* mode (socket + receive
queue, so the link transfer can arrive) while `needsLink`, *ready* mode (plus the `OutboxWorker`) while `ready`. All
per-device state lives in a `MessagingRuntime` that never outlives the session's database. The rules it implements:
[v2 delivery reliability](v2-delivery-reliability.md), [v2 account identity key](v2-account-identity-key.md),
[v2 history transfer and backups](v2-history-transfer-and-backups.md).

The README section "Protocol interpretations made here" lists every choice among readings of the spec (padding,
receipt-hint scopes, `complete_for_user_ids` per payload kind, link expiry, ...): read it before changing payload or
receipt code.

## Tests

505 jest tests as of 2026-11-13, in projects `core` (Node; multi-device scenarios against `FakeFixesServer`) and `app`
(jest-expo; adapters, hooks, screens). The Node SQLite adapter rethrows better-sqlite3 errors as plain `Error`s: the
native addon keeps the error class of the first Jest realm that loaded it, which made `instanceof Error` fail in later
test files. Neither the core tests nor the e2e suite run Expo's real `fetch`: test platform adapters against it
([expo/fetch pitfalls](expo-fetch-pitfalls.md)). Guides: [Run the app checks](run-app-checks.md),
[Make a development build](app-development-build.md).

Related: [fixes-server](fixes-server.md), [Expo SDK 57, not 58](expo-sdk-57-pin.md),
[Safety codes use the device's own identity key](safety-code-from-local-identity-key.md),
[Expo OS backups gotcha](expo-os-backups-leak-app-data.md), [Unit tests miss contract drift](contract-drift-needs-e2e.md).
