# Fixes app (`fixes-app`)

React Native (Expo, TypeScript) client of **Fixes v2**, the end-to-end encrypted chat app. The contract
with the server is [`../docs/protocol.md`](../docs/protocol.md) (revision 2); section numbers below (§…)
refer to it.

Status: **complete (parts 1–4)** — platform-independent core (crypto, API client, realtime socket,
local database, session lifecycle, messaging engine, trust, device linking with history transfer,
backups), the React hooks over it, and every screen of §14.

## Features

- **Accounts**: register (legacy welcome toast, then automatic login), login, log out (§13: drains the
  mailbox and flushes the outbox first, warns about unsent items, and asks first when the mailbox cannot
  be drained because messaging is not running, e.g. on the startup error screen), change password
  (signs out every other device), erase this device (two confirmations).
- **End-to-end encrypted 1:1 chat** between friends: inbox with §14 arrows/colours and relative times,
  conversation with status ticks, tap a failed message to retry, safety-code banner when a contact's
  identity key changes (§8). History lives only on your devices.
- **People**: Discover (user search, validated locally), profiles with Add friend / Request sent /
  Accept request / Friends, Message for friends only, friend requests screen with a badge on the
  Profile tab, Security (safety code, "Mark as verified").
- **Multi-device**: "Link this device" QR on a new device; "Link a new device" on a linked one (camera
  scan, verification of the scanned device, certificate, identity key and history transfer with
  progress and Resend); "Receive history" to refill a linked device; Devices screen with linked / not
  linked, last seen, removal and a notice for devices added after this one.
- **Own identity key**: safety codes and the "Linked" check use the AIK this phone holds, never the key
  the server reports. A phone whose stored AIK differs from the account key (reset on another device,
  or a server substituting its own key) is not linked on the server's word: it shows "Link this
  device" until a link transfer brings the account key, and the Security screen shows no code. An
  account without a key gets the AIK this phone holds back instead of a new one.
- **Backups**: encrypted file through the share sheet, protected by a recovery key that is confirmed
  before the first export and can be shown again; import with a summary (including contacts whose
  safety code differs).
- **Profile photo**: camera or library, square crop, resized to ≤ 1024 px JPEG 0.8, preview, Save.

## Screens

| Screen | Reached from | What it does |
|---|---|---|
| Splash | app start | Restoring the session; offline retry; error with Retry / Log Out |
| Login, Register | signed out | Legacy layout and texts (§14) |
| Link this device | logged in, not linked | QR for the linked device, progress, identity reset |
| Messages (tab) | — | Inbox, search filter, banners (gap → Receive history, local data reset → Backups / Receive history, offline, history arriving), FAB |
| New conversation | inbox FAB | Friends list with filter |
| Conversation | inbox row, profile "Message" | Bubbles, ticks, retry, composer, safety-code banner |
| Discover (tab) | — | Search users (`[A-Za-z0-9_]{1,30}`), open a profile |
| Profile (tab) | — | My avatar and name, Friend requests (badge), Settings, Log Out; edit icon |
| User profile | Discover, conversation header, friend requests | Friendship button states, Message, Security |
| Security | user profile, safety-code banner | Safety code (§4.4) from this phone's own AIK (a warning instead when it is missing or differs from the server's), Mark as verified, accept a changed code |
| Edit profile | Profile edit icon | Camera / library, preview, Save |
| Friend requests | Profile | Received (Accept / Decline), Sent (Cancel) |
| Settings | Profile | Devices, Link a new device, Receive history, Backups, Change password, Erase this device, privacy note (§15) |
| Devices | Settings | This device / Linked / Not linked, last seen, Remove (confirmation), new-device notice |
| Link a new device | Settings, Devices "Link" | Camera permission, scan, verification, progress, Resend |
| Receive history | Settings, gap banner | QR for an already linked device, progress, summary |
| Backups | Settings, local-data-reset banner | Create (recovery key + confirmation), show key, import + summary |
| Change password | Settings, new-device notice | Warning, current / new / repeat |

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20.19.4 or newer | Expo SDK 57 / React Native 0.86 support Node `^20.19.4`. |
| npm | 10 | Exact versions are pinned (`.npmrc` has `save-exact=true`). |
| Expo SDK | 57 | SDK 58 (the current `latest`) requires Node ≥ 22.13, so the project stays on 57 until the toolchain moves. |
| Native toolchain | Android SDK / Xcode | Only for building the app (see below). Not needed for tests, lint or `expo export`. |

`expo-font` and `expo-asset` are direct dependencies pinned to the SDK 57 versions `expo` itself uses:
`@expo/vector-icons` needs `expo-font` as a peer, and without a direct entry npm resolved that peer to
the SDK 58 release, which cannot find `expo-asset` (Jest and Metro both failed to load the icons).
`npx expo install --check` reports the tree as up to date.

## Development build (Expo Go is not supported)

The app needs native code and configuration that Expo Go cannot provide (§2):

- expo-sqlite is compiled **with SQLCipher** (`useSQLCipher: true` in the config plugin). Expo Go ships
  plain SQLite, and the app refuses to open its database without SQLCipher (`PRAGMA cipher_version`
  empty, §12.1), so it cannot run there at all.
- Config plugins set native options per build: `android.allowBackup: false` (§12.1), the camera
  permission text and the barcode scanner (link codes, profile photos), the photo library text,
  `RECORD_AUDIO` removed, the unused template permissions `SYSTEM_ALERT_WINDOW` and `VIBRATE` blocked
  (`android.blockedPermissions`), expo-secure-store without Face ID.
- `expo-dev-client` provides the development launcher that loads the JavaScript from Metro.

Build and install a development build once (and again whenever native dependencies, `app.json` or
plugins change); after that, JavaScript changes only need Metro.

```sh
# Local build: Android Studio (SDK + JDK 17) for Android, Xcode on macOS for iOS.
export EXPO_PUBLIC_API_URL=http://10.0.2.2:8000   # placeholder: your dev server (see Configuration)
npx expo prebuild --clean     # generates android/ and ios/ from app.json (both git-ignored)
npx expo run:android          # builds, installs the dev client on a device/emulator and starts Metro
npx expo run:ios              # macOS only
npm start                     # later sessions: Metro for the installed dev client
```

`expo run:*` runs the prebuild itself when the native folders are missing; use `prebuild --clean` after
changing `app.json` or a plugin. A release build (`npx expo run:android --variant release`,
`npx expo run:ios --configuration Release`) refuses any API URL that is not `https` (§3).

**EAS Build** (cloud builds, no local Android SDK or Xcode needed): install the CLI globally
(`npm install -g eas-cli`, deliberately not a project dependency), `eas login`, then `eas build:configure`
creates `eas.json`. Build with `eas build --profile development --platform android` (an installable dev
client) or `--profile production` for a store build. Give `EXPO_PUBLIC_API_URL` to EAS through its
environment variables (EAS dashboard or `eas env:create`) or the `env` block of the build profile in
`eas.json`; it is inlined when the bundle is built.

## Configuration

Configuration comes from environment variables at bundle time. `example.env` lists them with
placeholder values; put real values in your shell, CI/EAS environment, or a local dotenv file that you
create yourself and never commit (dotenv files are git-ignored).

| Variable | Placeholder | Used by | Meaning |
|---|---|---|---|
| `EXPO_PUBLIC_API_URL` | `https://fixes.example.com` | app | Server base URL **without** `/v1`. The WebSocket URL is derived (`wss://…/v1/ws`). Release builds refuse anything but `https`; dev builds also accept `http` (e.g. `http://10.0.2.2:8000` from the Android emulator). Read only in `src/platform/config.ts`. |
| `FIXES_E2E_API_URL` | `http://127.0.0.1:8000` | `npm run test:e2e` | Server the end-to-end suite talks to. |

`EXPO_PUBLIC_*` variables are inlined into the JavaScript bundle by Metro, so after changing
`EXPO_PUBLIC_API_URL` restart `npx expo start` (add `--clear` to drop cached bundles) or rebuild. A
missing or disallowed value is shown by the app as a startup error instead of crashing.

App identifiers in `app.json` are **placeholders** to replace before publishing:

| Setting | Value |
|---|---|
| `expo.name` / `slug` / `scheme` | `Fixes` / `fixes` / `fixes` |
| `android.package`, `ios.bundleIdentifier` | `app.fixes.mobile` (placeholder) |

Security-relevant native settings (verified with `npx expo config --type introspect`):
`android.allowBackup: false`; expo-sqlite plugin `useSQLCipher: true` (sets `expo.sqlite.useSQLCipher`
for Gradle and CocoaPods); camera permission text for scanning link codes and profile photos; photo
library permission text for choosing a profile photo; microphone disabled (`RECORD_AUDIO` removed);
`android.blockedPermissions` removes the bare template's `SYSTEM_ALERT_WINDOW` and `VIBRATE` (nothing
draws over other apps or vibrates). `READ_/WRITE_EXTERNAL_STORAGE` (maxSdk 32) stay: expo-image-picker's
camera needs `WRITE_EXTERNAL_STORAGE` on Android 7–9. expo-secure-store without Face ID. The generated
Android manifest is checked by `src/platform/__tests__/appConfig.test.ts`.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Metro for the dev client. |
| `npm run android` / `npm run ios` | Build and run the native dev build (`expo run:*`). |
| `npm test` (`npx jest`) | Unit tests: projects `core` (Node) and `app` (jest-expo). |
| `npm run test:e2e` | `e2e/` against a live server (`jest.e2e.config.js`); not part of `npm test`. |
| `npm run lint` (`npx expo lint`) | ESLint (flat config, `eslint-config-expo`). |
| `npm run typecheck` | `tsc --noEmit`. |

## Architecture

```
index.ts            imports 'react-native-get-random-values' FIRST (§2), then registers App
App.tsx             getAppServices() → <FixesApp> (src/ui); shows configuration errors
src/
  core/             pure TypeScript — no react, react-native or expo-* imports (ESLint-enforced)
    platform.ts     interfaces of the injected platform services (incl. FileAdapter)
    config.ts       API/WS URL validation (https in release)
    events.ts       tiny typed emitter
    logger.ts       Logger interface (engine warnings/errors; injectable for tests)
    crypto/         encoding, random, identity (AIK, certificates), deviceKeys, envelope,
                    transfer (QR-keyed sealed box), backup (recovery key + file), safetyCode
    api/            HttpTransport, TokenManager (single-flight refresh), ApiClient, §5.2 types,
                    response validation, ApiError/NetworkError
    realtime/       RealtimeSocket (§6) and backoff
    db/             schema + migrations (PRAGMA user_version), LocalStore (serialised access,
                    transactions), repositories, change notifier, SQLCipher key handshake, file
                    naming, live queries (QueryObserver, MessageWindowObserver) for the hooks
    session/        §12.1 secure-storage items, DB key management, SessionManager
    payloads/       §7 builders + strict validators: message, receipt, link inner, snapshot
                    records (Conv/Msg/Ident), kind/version dispatch, from/to and receipt scoping
    trust/          DeviceDirectory (§8): TOFU pins, AIK change → pending + system message,
                    eligible devices (60 s cache), sender-key resolution incl. revoked devices
    messaging/      MessagingEngine (public API) → MessagingRuntime per signed-in device:
                    ReceiveQueue + EnvelopeProcessor (receive), OutboxWorker (send/receipts),
                    receipt coalescing and hints, PeerProfiles, EnvelopeCodec
    linking/        link QR format, IncomingTransfers (new device), OutgoingLink (linked device)
    snapshot/       readSnapshot / chunkSnapshot (≤ 48 000 bytes) and the §10 merge rules
    backup/         BackupService (recovery-key lifecycle, export, import), file naming
    utils/          relativeTime (legacy port), validation, SerialQueue, backoff, StateCell
  hooks/            React glue: FixesProvider, useSession, useMessagingState, useLocalStore,
                    useConversations, useMessages, useContactIdentity, useLinkTransfer, useBackup
  ui/               screens and navigation: FixesApp, navigation/ (root switch by session status,
                    tabs), screens/, components/, hooks/ (UI-only), media/ (image picker +
                    manipulator for avatars), presentation/ (pure view logic: inbox rows, status
                    ticks, errors, search, friendship, devices, link progress), theme.ts
  platform/         Expo implementations of the platform services + getAppServices()
  test-utils/       Node implementations (better-sqlite3, in-memory secure store, ws, fetch upload),
                    fakes (FakeFixesServer with WebSocket push, FakeWebSocket, stub fetch,
                    MemoryFileAdapter) and createTestPhone() for multi-device tests
e2e/                end-to-end suite against a real server (see e2e/README.md)
```

Dependency rules: `src/core` imports nothing from `src/platform`, `src/test-utils` or any React/Expo
package; `src/platform`, `src/hooks`, `src/ui` and app code never import `src/test-utils`; `src/ui`
does not import `src/platform` either (services arrive through `FixesProvider`, so tests can pass fakes
or a test phone). All enforced by `eslint.config.js`. Every random value comes from `crypto.getRandomValues` (`core/crypto/random.ts`);
never use `Math.random`.

### Platform services (`src/core/platform.ts`)

| Interface | Expo implementation (`src/platform`) | Node implementation (`src/test-utils`) |
|---|---|---|
| `SqlDatabase` (`execAsync`, `runAsync` → `{changes, lastInsertRowId}`, `getAllAsync`, `getFirstAsync`, `withTransactionAsync`, `closeAsync`) | `wrapExpoDatabase` (expo-sqlite) | `wrapBetterSqlite`, `openMemoryDatabase` |
| `DatabaseOpener` (open with key, exists, moveAside, delete) | `expoDatabaseOpener`: opens `fixes-<user_id>.db`, `PRAGMA key` first, refuses if `PRAGMA cipher_version` is empty | `createNodeDatabaseOpener(dir)` (plain SQLite; records the key) |
| `SecureKeyValueStore` (`getItem`/`setItem`/`deleteItem`) | `expoSecureStore` with `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` | `MemorySecureStore` |
| `WebSocketFactory` | `nativeWebSocketFactory` (global WebSocket) | `wsWebSocketFactory` (`ws`), `FakeWebSocketFactory` |
| `HttpUpload` (multipart) | `nativeHttpUpload` (`FormData` part `{name: 'avatar.jpg', type: 'image/jpeg', bytes()}` read with expo-file-system's `File`: the global fetch is expo/fetch, which cannot encode RN's `{uri}` parts) | `fetchUpload` (reads a file path) |
| `Clock` | `systemClock` (core) | any `{ now }` |
| `FetchLike` | global `fetch` (default) | `createStubFetch` |
| `FileAdapter` (`shareFile` → cache file + share sheet + delete; `pickFile` → document picker `*/*`, copy to cache, read, delete) | `expoFileAdapter` (expo-file-system `File`/`Paths` API, expo-sharing, expo-document-picker) | `MemoryFileAdapter` |

### Session lifecycle (`core/session/sessionManager.ts`)

`SessionManager` is framework-agnostic and observable: `getState()` / `subscribe()` work with
`useSyncExternalStore`. State: `{status: 'loading' | 'signedOut' | 'needsLink' | 'ready', user, device,
offline, error, signedOutReason, localDataReset}`. The app-wide instance comes from
`getAppSessionManager()` in `src/platform/services.ts`.

- `start()` — RNG self-test (§2), then restore `fixes.session` (refresh tokens, load account and device).
  Offline → `loading` with `offline: true`, retried with backoff; `retry()` retries at once.
- `register()` — creates the account (the UI shows the welcome toast, then calls `login()`, §14).
- `login()` — generates the X25519 device key **before** the call, stores `fixes.device.<uid>` then
  `fixes.session`, opens the DB, then the §9 step-1 decision: no AIK on the server → create, store and
  `PUT /v1/users/me/identity`; matching AIK stored on this install → self-certify; otherwise `needsLink`.
- `refreshLinkState()` — re-check after `devices_changed` while waiting to be linked (the engine calls
  it). `adoptIdentity(aik)` stores a transferred AIK; the engine's link receiver performs the same checks
  and writes through `SecureItems` instead, because it may run inside the logout hook (see below).
- `logout()` — runs logout hooks (the messaging engine registers the §13 drain-mailbox/flush-outbox
  step), `POST /v1/auth/logout`, deletes `fixes.session` + `fixes.device.<uid>`, keeps the DB, DB key,
  identity and recovery key. Needs connectivity. The UI should call `MessagingEngine.logout()` (below),
  which turns "items remain" into a warning instead of an exception.
- `eraseDevice()` — best-effort server revoke, then deletes the DB files and every secure item of the
  user; returns `{serverRevoked}`.
- `resetIdentity(password)` — from `needsLink` only (§9 "I lost my other devices"). After a network error
  the outcome is unknown: the new AIK is kept and the link state is re-checked quietly (ready if the
  server applied the reset, otherwise still `needsLink`). Until the session is linked or ends, a repeated
  reset (the user tapping Reset again, online or offline) sends that same key instead of a new one, so a
  lost answer never rotates the account key twice.
- Revocation anywhere (`device_revoked` / `invalid_refresh_token` from any call, or the socket's 4401 path)
  → `signedOut` with the reason; session and device key deleted, local data kept (§6).
- DB key: `fixes.dbkey.<uid>` (32 random bytes, hex) applied as a raw SQLCipher key. A DB file without
  its key (restored OS backup) is moved aside and `localDataReset` is set (§12.1).

The messaging engine uses `api`, `items`, `getLocalStore()`, `getActiveDevice()` (device id + X25519
keys), `getIdentity()`, `envelopeKeys` (derived-key cache), `createSocket(factory)`, `addLogoutHook()`
and `refreshLinkState()` (interface `MessagingSession`). Logout hooks must not wait for SessionManager
actions (they run inside its operation queue).

### API client (`core/api`)

`ApiClient` has one method per §5.3 endpoint with §5.2 types; responses are validated at runtime
(`invalid_response` on contract violations). Non-2xx → `ApiError {status, code, message, details,
retryAfter}`; no HTTP response → `NetworkError {kind: 'offline' | 'timeout'}`. Each request has one
deadline that covers the response body too (expo/fetch resolves at the headers and the native stacks
have no read timeout): 30 s, 120 s for a `GET /v1/envelopes` page (up to about 4 MiB) and the avatar
upload; at the deadline the request is aborted. Authenticated calls take
the bearer token from `TokenManager`; a 401 `unauthorized` triggers **one** shared refresh and one retry.
The refresh is single-flight for all callers (REST and socket), persists the rotated refresh token to
secure storage **before** the new access token is used, and emits `signedOut` on `device_revoked` /
`invalid_refresh_token`. Helpers: `staleDevicesDetails()`, `tooManyDevicesDetails()`,
`isTransientError()`, `isSignedOutError()`.

### Realtime (`core/realtime/socket.ts`)

`RealtimeSocket` sends the auth frame on open (no token in the URL), emits `ready {gap}`, `envelope`,
`devices_changed`, `status` and `protocolError`, pings every 25 s and drops a connection that stays silent
for two ping periods. Close codes: 4401 → one refresh with the server (even when REST calls left a newer
access token in memory) then reconnect (sign-out if the refresh says so);
4408 and others → exponential backoff 1 s → 30 s with jitter; 4409 → stays down until `resume()` (call it
when the app returns to the foreground). `stop()` ends it; `sendAck(ids)` acks over the socket.

### Local database (`core/db`)

Schema §12.2 at `PRAGMA user_version = 1`; add migrations by appending to `MIGRATIONS`. `LocalStore`
serialises every statement and transaction on the single connection (expo-sqlite transactions are not
exclusive). Use `store.transaction(async (tx) => …)` and **only `tx` inside it** (using `store` there
deadlocks). Repositories: `conversations`, `messages` (insert-or-ignore returning whether a row was
inserted; forward-only, peer- and direction-scoped status updates that return the changed ids;
newest-first pagination by `(sort_ts, id)`), `outbox`, `receiptHints`, `contactIdentities`,
`historyTransfers`. Change notifications (`store.changes.subscribe(Topics.conversations | Topics.messages(peer)
| 'outbox' | 'contacts' | 'transfers' | 'receipt_hints', …)`) fire after commit and carry no data — UI
hooks re-query.

### Crypto (`core/crypto`)

Exactly as §4 and §7.3: Ed25519 AIK and device certificates (strict verification), X25519 device keys,
envelope XChaCha20-Poly1305 with HKDF info `"fixes/v1/envelope" || sender_pk || recipient_pk`, AAD
`fixes/v1|su|sd|rd`, space padding to 256-byte multiples, all-zero shared secret rejected, bounded
derived-key cache (keyed per direction as well, since the two directions derive different keys); transfer
sealed box; recovery key (Crockford, tolerant parsing) and backup file encryption; safety codes.
`openEnvelope` expects a sender public key the caller has already checked against the pinned AIK (§8).

### Messaging engine (`core/messaging`)

`MessagingEngine` follows the session (`attach()`): while the session is `needsLink` it runs in
**linking** mode (socket + receive queue, so the link transfer can arrive), while `ready` in **ready**
mode (plus the outbox worker); otherwise it is stopped. Everything per device lives in a
`MessagingRuntime` (socket, `DeviceDirectory`, `ReceiveQueue`, `OutboxWorker`, `PeerProfiles`, both
sides of linking) that never outlives the session's database. State for the UI:
`getState()/subscribe()` → `{status: 'stopped' | 'linking' | 'ready', connection, syncing, gap}`.

| API | What it does |
|---|---|
| `sendMessage(peer, body, {profile?})` | §13 send: validates (1–4000 code points, peer ≠ me, contact identity not pending), stores the message `pending` + outbox row in one transaction, wakes the worker. `profile` names a conversation that does not exist yet (otherwise a placeholder is created and fetched). |
| `retryMessage(id)` | failed → pending + outbox (tap to retry). |
| `markConversationRead(peer)` | `received → read` for this conversation, unread cleared, one coalesced `read` receipt for exactly the rows changed here (§7.2). |
| `acceptIdentityChange(peer)` / `setContactVerified(peer, v)` / `getContactIdentity(peer)` | §8 banner and "Mark as verified". |
| `ensureConversation(user)` | "New conversation" from the friends list. |
| `refreshPeers({force?})` | `GET /v1/users?ids=` for all conversations, at most once a minute. |
| `syncNow()`, `onForeground()`, `dismissGap()` | pull-to-refresh drain; foreground (socket `resume()` after 4409, outbox run); hide the gap banner. |
| `logout({force?})` | §13 logout: drain, flush, then `{status: 'loggedOut'}` or `{status: 'unsent', remaining}` (call again with `force: true` after warning the user). |
| `createLinkQr()`, `cancelIncomingLink()`, `startLink(qr)`, `resendLink()`, `cancelLink()`, `resetLink()` | §9 linking; progress in `incomingLink` / `outgoingLink` (StateCells). |

Receive (§13): one serial queue. On `ready` pushes are buffered and `GET /v1/envelopes` is drained page
by page; each page is resolved/decrypted/validated first (network allowed), then applied in **one**
transaction and acked in one batch; buffered pushes follow, skipping ids applied this session.
Permanent failures (decrypt/validation, ineligible sender, unknown kind) are acked; an undecryptable
envelope from someone with a conversation adds "A message from <username> could not be decrypted", and
consecutive ones from that contact update the same notice in place ("<n> messages from <username> could
not be decrypted"; `undecryptableNotices.ts`) until a message from them is stored.
Transient failures (network/5xx while resolving keys, unexpected local errors) stop the queue without
acking the rest and retry with backoff. Apply is idempotent; unread counts and delivered receipts change
only for inserted rows; unknown peers get a placeholder conversation ("Unknown user") and a background
profile fetch; `gap: true` sets `state.gap`.

Send (§13): the worker runs on socket ready, foreground, enqueue and when a scheduled retry is due.
Errors: network/5xx/401 → backoff 1 s → 5 min and the queue pauses; `stale_devices` → fresh lists and one
immediate retry; `not_friends`, other definitive 4xx, a pending contact identity or no eligible device →
`failed`; `rate_limited` → pause until `Retry-After`. Receipts are queued in the outbox **in the same
transaction** as the change that caused them and coalesced per (peer, status) during a ~1 s window
(`receiptQueue.ts`); delivered receipts go to the peer's devices (`complete_for_user_ids: [peer]`), read
receipts also to my other devices (`[peer, me]`). Receipts naming unknown messages become
`receipt_hints` and are applied when the row appears (live, history import, backup import).

All delays are in `MessagingTimings` (`timings.ts`) with the protocol values as defaults.

### Trust (`core/trust`)

`DeviceDirectory` (§8): `devicesFor(user)` returns the devices whose certificate verifies under the
pinned AIK (TOFU pin on first sight; own devices use the AIK this install holds, or the account key while
it holds none; a device certified only by a different account key the server reports may deliver the
`link` and `history` transfer, which the QR secret authenticates, but its sync copies and read syncs are
dropped) and the identity state
(`pinned | pending | none`), cached 60 s per user and invalidated on `stale_devices`, `devices_changed`
(own) and every socket (re)connect (own). A server key that differs from the pin is stored as
`pending_identity_key` with a "<username>'s safety code changed" system message; sending stays blocked
until `acceptIdentityChange`, while devices certified by the pending key are accepted as senders.
`resolveSender(user, device, created_at)` uses the (fresh) cached list, else
`GET /v1/users/{id}/devices/{device_id}`; a revoked device is accepted only for envelopes created before
`revoked_at`.

### Linking (`core/linking`)

- New device (`IncomingTransfers`): `createQr()` stores `transfer_id` + key in `history_transfers` and
  returns `fixes-link:1:<transfer>:<device>:<pk b64url>:<key b64url>` (the same code while open).
  `link`/`history` envelopes are accepted only from another device of mine, for an open transfer, bound
  to the first sender device (others ignored); a new attempt resets `total`/`received_seqs`. The `link`
  inner AIK must equal `users.identity_key` and match its secret; it is stored in secure storage and the
  session re-checks its link state (→ `ready`). Completion deletes the key. Expiry: 30 min without a
  chunk, then 10 min of inactivity → `phase: 'expired'` (row deleted).
- Linked device (`OutgoingLink`): parses the QR strictly, requires the device in `GET /v1/devices` with
  exactly that key, certifies it (unless already certified), sends `link`, drains its own mailbox,
  snapshots in one read transaction, chunks to ≤ 48 000 bytes and posts batches with progress
  (`sentChunks/totalChunks`). 401/409 abort; interruptions, rate limits and full mailboxes offer
  `resend()` (new attempt, same QR). Each attempt re-sends `link` too.
- The UI keeps the screen awake (expo-keep-awake) while a transfer runs; core only exposes phases.

### Backups (`core/backup`)

`BackupService`: `beginExport()` returns a new recovery key to show (first export only; held in memory
until confirmed), `confirmRecoveryKey(lastGroup)` stores it in `fixes.backupkey.<uid>`,
`exportBackup()` encrypts the snapshot and hands `fixes-backup-<username>-<YYYYMMDD-HHmm>.fixes` to
`FileAdapter.shareFile`; `getRecoveryKey()` shows it again. Import: `openBackupFile()` (picker, strict
header check, owner check) then `importBackup(handle, key)` (wrong key → `wrong_recovery_key`, nothing
changed) merges per §10 in one transaction and returns counts and `identityConflicts`. Errors are
`BackupError` with a `code` and a user-facing message.

### React hooks (`src/hooks`) and app services

`getAppServices()` (`src/platform/services.ts`) returns the app-wide `{session, messaging, backup}`
(engine attached, AppState foreground forwarded). Wrap the UI in `<FixesProvider services={…}>` and use:

| Hook | Returns |
|---|---|
| `useSession()` / `useMessagingState()` | session state / engine state (connection, syncing, gap) |
| `useLocalStore()` | the open `LocalStore` or null |
| `useConversations()` | `{data: InboxRow[], loading, error, reload}`, re-queried after every commit |
| `useMessages(peer, pageSize = 30)` | `{messages (newest first), hasMore, loadMore, loading, loadingMore, error, reload}` |
| `useContactIdentity(peer)` | the pin (banner while `pending_identity_key` is set) |
| `useLinkTransfer()` | `{incoming, outgoing, createQr, cancelIncoming, startLink, resend, cancel, reset}` |
| `useBackup()` | export/import state machine: `step` (`idle`, `working`, `confirmKey`, `exported`, `needKey`, `imported`), `recoveryKey`, `error`, actions |

The data hooks use `useSyncExternalStore` over the observers in `core/db/liveQuery.ts`, which keeps them
within the React Compiler lint rules enabled by `eslint-config-expo`.

### UI (`src/ui`)

`App.tsx` calls `getAppServices()` and renders `FixesApp` (`src/ui/FixesApp.tsx`): `SafeAreaProvider` →
`FixesProvider` → `ToastProvider` → session start (`session.start()` once, with a retry screen if the
local start fails) → `TransferKeepAwake` → `FriendRequestCountProvider` (incoming request count, polled
every 60 s while the app is in the foreground: friend requests have no realtime event) →
`NavigationContainer` → `RootNavigator`.

Navigation (`src/ui/navigation`, types in `types.ts`): one native stack whose screens depend on the
session status (§9 step 1), so every status change replaces the stack:

| Status | Screens |
|---|---|
| `loading` | `Splash` (spinner; "No internet connection — retrying…" with Retry now; on a non-network error: message, Retry, Log Out) |
| `signedOut` | `Login`, `Register` (headerless, legacy layout) |
| `needsLink` | `NeedsLink` ("Link this device": QR, progress, reset-identity panel, Log Out) |
| `ready` | `Main` = bottom tabs `Messages` (inbox) / `Discover` / `Profile`, plus stack screens `Conversation {peerUserId, peerUsername?, profile?}`, `NewConversation`, `UserProfile {userId, username?}`, `Security {userId, username?}`, `EditProfile`, `FriendRequests`, `Settings`, `Devices`, `LinkDevice`, `ReceiveHistory`, `Backup`, `ChangePassword` |

Screens (`src/ui/screens`):

- **Login / Register** (§14): legacy layout (logo, Username, Password, Login, "or", Create account).
  Login checks the format locally ("Enter your username and password." / legacy "Invalid
  username/password"), shows `Loading..` on a disabled button while working, clears the password after
  a failure, keeps "No internet connection", explains `too_many_devices` and rate limits, and shows
  "This device was signed out" after a revocation (`signedOutReason`). Register validates both fields,
  shows the legacy toast "Welcome to Fixes <username>, please login to continue!" and logs in itself.
- **NeedsLink**: `createLinkQr()` on mount (`useLinkQr`), QR via react-native-qrcode-svg (`LinkQrCard`,
  shared with Receive history), transfer progress, "Transfer incomplete, retry" → new code, the collapsed "I lost my other devices — reset my security identity"
  panel (consequences listed, password required, `session.resetIdentity`), Log Out.
- **Inbox**: search bar (local username filter), rows from `useConversations()` (`ConversationRow`:
  avatar with placeholder fallback, username, relative time ticking every 15 s, arrow → / ← in the §14
  colour, retry icon for failed, bold while the newest message is incoming and unread), banners (gap
  with dismiss, offline while the socket backs off, history still arriving after linking, transfer
  expired), pull to refresh (`syncNow` + forced peer refresh), `refreshPeers()` on focus, black FAB →
  New conversation.
- **NewConversation**: `GET /v1/friends` (`useApiQuery`), local filter, tap → `Conversation` with the
  friend's profile (the conversation row is created by the first message, `sendMessage(..., {profile})`).
- **Conversation**: inverted `FlatList` over `useMessages()` (opens and stays on the newest message,
  older pages on scroll), `MessageBubble` (mine right/black, theirs left/outlined, system centred;
  time + §14-coloured ticks under my bubbles; failed → "Not sent. Tap to retry." → `retryMessage`),
  `Composer` (4000 code points, counter near the limit, trimmed body), safety-code banner with Accept
  and "View safety code" while `pending_identity_key` is set (composer disabled), `markConversationRead`
  while focused and the app is in the foreground (on focus and for every new unread message),
  `KeyboardAvoidingScreen`, header button → `UserProfile` (whose "Message" pops back to this screen).
- **Inbox banners** also offer "Receive history" on the gap notice and, after a database had to be set
  aside (§12.1 `localDataReset`), Import backup / Receive history.
- **Discover** (tab): the search bar submits (`validateSearchInput`: trimmed, `[A-Za-z0-9_]{1,30}`, else
  "Search with 1 to 30 letters, digits or underscores." without calling the server), results as
  `UserRow`s (the caller is filtered out even if the server returned it), start / loading / empty /
  error-with-Retry states; only the newest search may show its answer.
- **UserProfile**: `getUser` + friends + friend requests (`friendshipWith`), avatar and name, then
  Add friend → Request sent (tap: confirm, cancel) → Accept request / Decline → Friends (tap: confirm,
  unfriend) with Message (friends only, §1); Security row. Answers that only mean the screen is stale
  (`already_friends`, `request_exists`, `not_found`) just reload; a deleted user shows "This user no
  longer exists."
- **Security**: safety code (§4.4) of my AIK and the pinned one as a 3×4 grid, "Mark as verified" /
  "Mark as not verified" (`setContactVerified`); while a changed key is pending, the new code with
  "Accept new safety code"; without a pin yet, an explanation (the pin is made on the first exchange).
- **Profile** (tab): `getMe()` on focus (a new avatar shows up), Friend requests with the incoming
  count, Settings, Log Out (`useLogout`: confirms when `logout()` reports unsent items); edit icon.
- **EditProfile**: Choose from library / Camera (`media/avatarPicker.ts`: camera permission only for
  the camera, system editor with a square crop, then expo-image-manipulator: centred square crop if
  still needed, resize to ≤ 1024 px, JPEG 0.8), round preview of exactly the processed file, Save →
  `uploadAvatar`; `invalid_image` / `payload_too_large` are explained, other failures show the legacy
  "Error uploading image, please try again later"; a permanently refused permission offers the system
  settings.
- **FriendRequests**: sections Received (Accept / Decline) and Sent (Cancel), "Received 2 hours ago",
  pull to refresh, empty state → Discover; reports its fresh count to the badge.
- **Settings**: Devices, Link a new device, Receive history, Backups, Change password, Erase this device
  (two confirmations, then `session.eraseDevice()`; an offline erase tells the user to remove the
  device from another one), and the §15 privacy summary.
- **Devices**: `GET /v1/devices` → `deviceViews`: this device first, "Linked" only when the certificate
  verifies under the account AIK **on this phone**, "Not linked" (with a Link shortcut), last seen,
  "NEW" plus a warning banner for devices added after this one within 7 days (→ Change password),
  Remove with a destructive confirmation → `DELETE /v1/devices/{id}`, "n of 10 devices".
- **LinkDevice** (§9 steps 3–4): camera permission (explained first; settings link when blocked),
  `CameraView` with `barcodeScannerSettings: {barcodeTypes: ['qr']}`; every scan is parsed strictly
  (`parseLinkQr`); a valid code is checked against `GET /v1/devices` (listed, exactly that key) and the
  user confirms the device name before `startLink`; progress per phase with a progress bar, Cancel,
  Resend after an interruption, Scan again, Done. Leaving while it runs asks first
  (`usePreventRemove`); `TransferKeepAwake` keeps the screen on.
- **ReceiveHistory**: an already linked device shows a link code (`createLinkQr` works in ready mode),
  the other device scans it under "Link a new device"; progress and "n messages were added". Leaving
  before anything arrived cancels the transfer so its secret stops being valid.
- **Backup** (`useBackup`): Create backup → recovery key shown → "I wrote it down" → key hidden, last
  group typed (tolerant input) → share sheet → summary; Show recovery key; Import backup → picked file
  (name, date) → recovery key → summary with added/updated counts, skipped rows and contacts whose
  safety code differs (names from the local conversations).
- **ChangePassword**: warning that every other device is signed out and loses what has not reached it,
  current / new / repeat fields, `POST /v1/auth/password`, toast and back.

Building blocks: `theme.ts` (legacy monochrome, §14 `statusColors`, `MIN_TOUCH_SIZE` 44,
`headerOptions`), `components/` (Avatar, Banner, Button, Composer, `confirm()` (two-button native
dialog as a promise), ConversationRow, CountBadge, EmptyState, FAB, Icon/IconButton (Ionicons from
`@expo/vector-icons`), KeyboardAvoidingScreen, LinkQrCard, ListItem, Logo, MessageBubble, ProgressBar,
SafetyCodeView, SearchBar, StateViews (LoadingState, ErrorState, InlineError), TextField, Toast,
TransferKeepAwake, UserRow), `hooks/` (`useNow`, `useAppActive`, `useApiQuery` for server data,
`useReloadOnFocus`, `useFriendRequestCount`, `useLinkQr`, `useLogout`), `presentation/` (`inboxPreview`,
`filterByUsername`, `outgoingStatus`, `describeError` / `reportBackgroundError`, `validateSearchInput`,
`friendshipWith`, `deviceViews`, `avatarPlan`, link progress texts, password form checks). Icon buttons
carry an `accessibilityLabel`; touch targets are at least 44 pt; JSX text with quotes goes through
`{'…'}` (`react/no-unescaped-entities`).

### Extending the UI

- Routes and params live in `navigation/types.ts`; screens get services only through `useFixes()` and
  the `src/hooks` hooks (ESLint keeps `src/platform` and `src/test-utils` out of `src/ui`). Server data:
  `useFixes().session.api` with `useApiQuery` (+ `useReloadOnFocus`); errors:
  `describeError(error, {code: text})`.
- UI tests: `renderScreen(name, Screen, services, params)` (`src/ui/__tests__/support/renderScreen.tsx`)
  renders one screen with the providers over a stub `Main`, every other route stubbed
  (`stub-<Route>` shows the params). Services come from `createFakeServices()` (every API call is a
  `jest.fn`) or a real `createTestPhone(new FakeFixesServer())` (`servicesOfPhone`). Whole-app flows
  render `<FixesApp services={…}>` (see `messaging.integration.test.tsx`). Let lists settle inside
  `act()` (a short act-wrapped wait), or VirtualizedList batching timers cause act() warnings.

## Testing

- `npx jest` runs the `core` project (Node environment: crypto, API client with a stubbed fetch, socket
  with a fake WebSocket and fake timers, repositories on better-sqlite3, session flows, payload
  validators, and multi-device integration scenarios (Alice and Bob with two devices each) against
  `FakeFixesServer`) and the `app` project (jest-expo: Expo adapters, hooks, components, screens and
  navigation, App).
- UI tests (`src/ui/__tests__`): components (inbox row arrow/colour/bold/relative time, bubble alignment
  and ticks, composer limits, avatar fallback), Login/Register validation and the disabled submit, the
  root switch by session status with fake services, keep-awake, logout confirmation, screen flows
  against two real test phones (send with ticks, receive and mark read, retry a failed message, the
  safety-code banner, inbox filter and gap banner), and since part 4: Discover search validation and
  results, every UserProfile friendship state and its action, Security (code, Mark as verified, accept
  a changed key) on a real phone, Backups (recovery-key confirmation, show again, export, import with a
  wrong then the right key and an identity conflict) on a real phone, Devices (statuses, new-device
  notice, revoke only after confirmation), Settings navigation and the double-confirmed erase (also
  against a real running engine), Change password, Edit profile (crop/resize/JPEG pipeline with mocked
  native modules, error texts, permissions), friend requests and the Profile tab badge, and linking
  with two real phones (scan → verify → link → history; a device that is not logged in is refused;
  Receive history on a linked device). Pure view logic is covered in `presentation.test.ts`.
  `jest.setup.app.js` swaps in the safe-area-context Jest mock and treats icon fonts as loaded.
- `FakeFixesServer` (`src/test-utils/fakeServer/`) implements the §5.3 auth, identity/device, user,
  friend and envelope endpoints (all POST checks, mailbox caps, gap) and the §6 WebSocket (auth, ready,
  live push, `devices_changed`, ack, 4401/4409). Admin hooks for tests: `interceptor` / `responseFilter`
  (fault injection, a "compromised server"), `holdFilter` + `releaseHeld()` (reordering),
  `injectEnvelope()`, `advanceClock()`, `posts` / `log` (traffic counting). `createTestPhone()` with
  `waitFor()` / `waitForQuiet()` builds scenarios; engine delays are shortened (`FAST_TIMINGS`).
- The Node SQLite adapter rethrows better-sqlite3 errors as ordinary `Error`s: its native addon keeps the
  error class of the first Jest realm that loaded it, which made errors in later test files fail
  `instanceof Error` (an order-dependent flake).
- **End-to-end suite** (`npm run test:e2e`, not part of `npx jest`): `e2e/messaging.test.ts` drives the
  real core (sessions, engines, linking, backups) against a real `fixes-server` over HTTP/WebSocket —
  friends, live and offline delivery, receipts, multi-device fan-out and linking with history,
  revocation, mailbox caps, identity reset, avatar upload and logout. Point it at a server with
  `FIXES_E2E_API_URL`, or use the server's launcher (`fixes-server/scripts/e2e_server.py`), which starts
  a throwaway server and database and cleans up; see `e2e/README.md`. It exercises the core, not the
  screens (no device or emulator is involved).
- Tests generate all keys and passwords at runtime; nothing secret is committed.
- `npx expo export --platform android --output-dir <dir outside the project>` proves Metro can bundle.

## Protocol interpretations made here

- Padding: an already 256-aligned plaintext gets no extra block; payloads larger than 65 280 padded bytes
  (the 65 536-byte ciphertext limit minus the tag) are refused before sending.
- The derived-key cache key includes the direction (send/receive), because the HKDF info order makes the
  two directions' keys different.
- `PRAGMA key` uses the raw-key form `x'<64 hex>'` (the key is already 256 random bits, so SQLCipher's
  passphrase KDF is skipped).
- `relativeTime` keeps the legacy thresholds and wording, but counts 30-day months and 365-day years in
  the last two bands (legacy printed the day count there, e.g. "40 months ago").
- An offline launch stays in `loading` (with `offline: true`) because §12.1 stores no profile or link
  state that could be trusted offline.
- Receipt hints: §12.2 gives `receipt_hints` no scope column, so the scope is encoded in `status`:
  `delivered`/`read` (from the peer, applied to my outgoing rows only) and `read_sync` (from my own
  devices, applied to incoming rows only, never displaced by a peer's hint for the same id).
- A receipt from another user must name me as `peer` (its `peer` is "the other party seen from the
  generator"); own devices only send `read` (read sync). Anything else is dropped.
- "1–4000 chars" (message body) counts Unicode code points; strings with unpaired surrogates are invalid.
- Receipts to a contact whose new key awaits acceptance are not sent to that contact (read sync to my own
  devices still is); a contact that is no longer a friend gets no receipt.
- `complete_for_user_ids`: messages `[peer, me]`; delivered receipts `[peer]`; read receipts `[peer, me]`
  (only for the users actually targeted); link/history envelopes none.
- The undecryptable-message system message is added for any permanently unreadable envelope from another
  user who has a conversation on this device (the kind is unknown before decryption), and for invalid
  `message` payloads; never for envelopes from my own devices.
- Collapsed undecryptable notices (§13): §12.2 has no column for the run, so it is kept in the notice row
  itself. The open notice is the contact's most recently inserted one (SQLite rowid order) as long as no
  incoming row was inserted after it; any stored message from the contact ends the run (also one from a
  history or backup import), a duplicate that was not inserted does not. The count is in the body, the
  `created_at` of the newest envelope counted in `server_ts`; `sort_ts` stays at the first failure, so the
  notice keeps its place. Cost: finding the newest notice walks the contact's whole conversation, so the
  processor does it once per contact and session, then follows the notice with a cursor (its rowid and the
  highest rowid already checked) and per failure checks only the rows inserted since, by rowid range. A
  flood costs the same in a long conversation as in an empty one. The cursor is re-checked against the
  database (the notice still there, no newer notice from another writer) and moves only when its
  transaction commits, because a rolled-back transaction's rowids are handed out again. This relies on
  the app never deleting message rows or running VACUUM.
  Each envelope counts once: the processor remembers what it counted this session, and after a restart
  (while it has not yet changed the open notice) an envelope no newer than the notice's `server_ts` is
  taken as the redelivery of a page that was applied but not acked. Limit: that test is not exact. The
  mailbox lists envelopes in id order (§5.3), but the server takes `created_at` before it locks the
  mailboxes and assigns ids inside the lock, and one POST gives all its envelopes one `created_at`; an
  exact test needs the last counted envelope id, for which §12.2 has no column. So, right after a
  restart:
  - the rest of a multi-envelope POST to this device whose first part was counted before the restart is
    not counted. Honest contacts send one envelope per device per POST, but the hostile flood this rule
    is about can send 100 at once, and a page can end inside them (the 4 MiB page cap gives pages of 64
    at 64 KiB ciphertexts; earlier envelopes from other senders shift the boundary);
  - a new envelope listed after one with a later `created_at` (concurrent POSTs racing for the lock, a
    server clock step) is not counted;
  - when such an inversion straddles the end of a run, a redelivered envelope can look newer than the
    open notice: it is counted again, and since that notice has now changed this session, the rest of the
    redelivered page is counted again too.
  The undercount ends with the first failure newer than the notice; tests in
  `src/core/messaging/__tests__/undecryptableNotices.test.ts` pin all three cases. A notice written
  before counting existed (no `server_ts`) is continued with its count of one.
- A drain runs until an empty page. Envelopes are acked over REST.
- Unexpected local errors while processing an envelope (not one of §13's permanent classes) are treated as
  transient: the envelope stays in the mailbox and is retried rather than risking a lost message.
- Linking: the `link` envelope counts as the first chunk for the 30-minute rule; every attempt (also a
  resend) sends `link` and then the history chunks under one `attempt_id`; an expired transfer's row (and
  key) is deleted. `Ident.verified` is written as a boolean and read as boolean or 0/1. History imports
  keep incoming statuses (only backups mark them read). An Ident for my own user is skipped.
- "Scanning a link QR marks the user's own new device as verified locally": §12.2 has no table for own
  devices, so nothing is persisted; the certificate is the trust anchor.
- `sendMessage` refuses (`identity_pending`) while a contact's key change is unaccepted instead of storing a
  message that would fail at once; queued messages that hit the change become `failed`.
- Backup file names use the phone's local time. Logout with unsent outbox items needs `force` (the items
  stay in the local database and are sent by the next login on this phone).
- UI (part 3): "This device was signed out" (§6) is shown on the Login screen, where a revoked session
  lands, not in the inbox. Inbox rows are bold when the newest non-system message is incoming with status
  `received`; their time is that message's `sort_ts` (else the conversation's last activity). Messages
  count as read only while their conversation is focused and the app is in the foreground. The composer
  trims leading/trailing whitespace. A format-invalid login is answered locally with the legacy
  "Invalid username/password". Status ticks use the §14 arrow colours and sit under the bubble (blue on
  a black bubble would be unreadable). When the automatic login after Register fails, the account is
  kept and the error is shown on Register.
- UI (part 4): Discover trims surrounding whitespace before the §14 format check. "Not linked" on the
  Devices screen means the certificate does not verify under the account AIK on this phone (not merely
  `certificate: null`). The "unexpected device" notice (§8 does not define it) flags devices created
  after this one within the last 7 days. A contact without a pin has no safety code yet (the pin is made
  on first use, §8); while a changed key is pending, Security shows the code of the pending key, the one
  Accept would pin. The link screen adds a human confirmation of the scanned device's name between the
  §9 step-3 checks and certification. An already linked device can show a link code ("Receive history")
  to refill its history after a gap; the transfer is cancelled if the screen is left before anything
  arrived. The avatar is processed right after picking so the preview is exactly what Save uploads;
  only the camera asks for a permission. The friend-request badge is polled every 60 s while the app
  is in the foreground. The recovery key is hidden while its last group is typed.
