# Fixes v2 — architecture and protocol

The contract between `fixes-server/` (Python) and `fixes-app/` (React Native). Both sides implement exactly this;
change this file first when the contract changes. The legacy .NET API (`Fixes/`) and Xamarin app (`xamFixes/`) are
kept untouched as reference. Revision 2.2 (design review, then clarifications from implementation and three
code-review rounds).

## 1. Goals and non-goals

- Same product as the legacy app: accounts, profiles with avatar, user search, friendships, and an end-to-end
  encrypted (E2EE) 1:1 chat whose history lives **only on the user's devices**.
- The server never stores conversations: it relays opaque ciphertext envelopes and deletes each one when the recipient
  device acknowledges it (or when it expires). §15 lists precisely what the server can see and keep.
- **Multi-device**: an account has one *identity key*; every device must be certified by it (first device: itself;
  later devices: by scanning a QR code on an already linked device). Messages are encrypted for each certified device
  of the recipient and each other certified device of the sender. A password alone never grants access to messages.
- **History transfer** happens during device linking: device to device, verified by the QR code, relayed as E2EE
  envelopes with an extra layer keyed by a secret that only travels inside the QR code.
- **Backups**: an encrypted file, protected by an app-generated recovery key, saved wherever the user chooses (share
  sheet). Never uploaded to the Fixes server. OS-level backups of app data are deliberately disabled/neutralised (§12.1).
- **Messaging requires friendship** (product decision; protects against spam and mailbox flooding). Legacy allowed
  messaging any user from their profile; v2 shows "Add friend" instead until the request is accepted.
- **Cloud-provider independent**: MongoDB (any host; standalone server supported, no transactions needed), S3-compatible
  object storage *or* the local filesystem for avatars, env-var configuration, Docker Compose (optional Caddy TLS proxy).
- Non-goals (documented follow-ups): forward secrecy / double ratchet, group chats, sealed sender, image/file
  attachments (the legacy camera button in the chat was a placeholder), posts/feed (legacy Home and New Post tabs were
  placeholders; avatar change lives in Edit Profile), push notifications, multi-instance WebSocket fan-out, migration
  of legacy accounts or legacy local databases (users re-register).

## 2. Components

| Component | Tech |
|---|---|
| `fixes-server/` | Python 3.12+, FastAPI, `uvicorn[standard]`, Pydantic v2, pydantic-settings, PyMongo async API (`AsyncMongoClient`; not Motor), argon2-cffi, PyJWT, `cryptography` (Ed25519/X25519 validation), Pillow, python-multipart, boto3 (S3 backend only) |
| `fixes-app/` | Expo SDK 57 (TypeScript; SDK 58 needs Node 22) **development build** (SQLCipher needs native config; Expo Go is not supported), React Navigation, expo-sqlite (SQLCipher), expo-secure-store, expo-camera, expo-image-picker, expo-image-manipulator, expo-file-system, expo-sharing, expo-document-picker, expo-keep-awake, @noble/curves (x25519, ed25519), @noble/ciphers, @noble/hashes, @scure/base, react-native-get-random-values, react-native-svg, react-native-qrcode-svg |
| Database | MongoDB 7+ (server): accounts, identity keys, devices, friendships, transient envelopes. SQLite/SQLCipher (device): conversations and messages. |
| Object storage | `local` (filesystem, served at `/media/...`) or `s3` (any S3-compatible API, public-read bucket or CDN) |

Server rules: run **one** API process (realtime fan-out and rate limits are in memory). CPU/blocking work — argon2,
Pillow, boto3 — runs in worker threads (`anyio.to_thread.run_sync`) behind a `CapacityLimiter(4)`, never directly in
async handlers. No multi-document transactions; multi-step writes use the crash-safe orders given below.

App rules: `import 'react-native-get-random-values'` is the **first** import of the entry file, before any `@noble`
module. Every random value (keys, nonces, salts, ids, transfer secrets) comes from `crypto.getRandomValues`, never
`Math.random`. At startup the app self-tests that 32 random bytes can be generated.

## 3. Identifiers, encodings, time

- User, device, message, transfer and attempt ids: lowercase UUIDv4 strings. Envelope ids: opaque strings
  (server-generated, monotonically increasing per process — a MongoDB ObjectId hex string).
- Binary values in JSON: **standard base64 with padding** (RFC 4648 §4). QR payloads: base64url without padding.
- Server timestamps in JSON: ISO 8601 UTC with milliseconds and `Z`. Inside payloads and the local DB: integer
  milliseconds since the Unix epoch.
- Usernames: `^[A-Za-z0-9_]{3,30}$`, unique case-insensitively (`username_lower`), displayed as registered. Login and
  uniqueness use `username_lower`.
- Passwords: 8–128 characters.
- Production is **HTTPS/WSS only**. Release app builds refuse a non-`https` API URL; cleartext is allowed in dev builds.

## 4. Cryptography (client side; the server only validates public values)

### 4.1 Keys
- **Account identity key (AIK)**: Ed25519, one per account, created by the account's first device. Public part stored on
  the server (`users.identity_key`); secret part only on linked devices (secure storage) and inside a link transfer.
- **Device key**: X25519, generated per login (each login = a new device). Public key registered at login; secret key
  never leaves the device.
- **Device certificate**: `Ed25519.sign(AIK_secret, UTF-8("fixes/v1/device-cert|" + user_id + "|" + device_id + "|" + device_public_key_b64))`,
  64 bytes, base64. A device is **linked** once its certificate is stored. The server verifies certificates against
  `users.identity_key` before storing them; clients verify them again against their own pinned AIK for that user.

### 4.2 Envelope encryption
For one plaintext payload `P` from sender device `S` (user `su`, device id `sd`, keys `s_sk`/`s_pk`) to recipient device
`R` (device id `rd`, public key `r_pk`):

```
shared = X25519(s_sk, r_pk)                                       # 32 bytes; all-zero result = error
key    = HKDF-SHA256(ikm=shared, salt=<empty>, info="fixes/v1/envelope" || s_pk || r_pk, L=32)
nonce  = 24 random bytes
aad    = UTF-8("fixes/v1|" + su + "|" + sd + "|" + rd)
pt     = UTF-8(JSON(P)) right-padded with ASCII spaces (0x20) to the next multiple of 256 bytes
ct     = XChaCha20-Poly1305(key, nonce).encrypt(pt, aad)
```
The recipient recomputes `shared = X25519(r_sk, s_pk)` with the same `info` order (**sender public key first**) and
parses the JSON (trailing spaces are valid JSON whitespace). The derived `key` is deterministic per device pair and may
be cached in memory keyed by (local device id, peer device id, peer public key).

Sender key resolution (in order): in-memory/DB cache of verified devices → `GET /v1/users/{su}/devices/{sd}`. The
device must carry a certificate that verifies under the AIK pinned for `su` (§8), and if it is revoked the envelope's
`created_at` must be earlier than `revoked_at`. Properties: confidentiality + sender-device authentication
(static-static DH). No forward secrecy (documented limitation).

### 4.3 Backup encryption
The **recovery key** is 120 random bits shown as 24 Crockford base32 characters in 6 groups of 4
(`7K3M-Q9TD-...`), generated by the app on the first export, stored in secure storage (`fixes.backupkey.<user_id>`),
viewable again in Settings, and confirmed by the user (re-typing the last group) before the first export completes.
```
salt  = 16 random bytes
key   = HKDF-SHA256(ikm=recovery_key_bytes(15), salt=salt, info="fixes/v1/backup", L=32)
nonce = 24 random bytes
aad   = UTF-8("fixes-backup/v1|" + user_id + "|" + created_at + "|" + salt_b64)
ct    = XChaCha20-Poly1305(key, nonce).encrypt(UTF-8(JSON(backup_body)), aad)
```
Input parsing of a recovery key is case-insensitive, ignores `-` and spaces, and maps `O→0`, `I/L→1`.

### 4.4 Safety codes
Per contact pair: `h = SHA-256(UTF-8("fixes/v1/safety") || k1 || k2)` where `k1 ≤ k2` are the two raw 32-byte AIK
public keys ordered byte-wise. Rendered as 12 groups of 5 digits: group *i* = `((h[2i] << 8) | h[2i+1])` zero-padded
to 5 digits. Shown on the contact's profile ("Security"); both users see the same code.

## 5. Server REST API

Base path `/v1`, JSON bodies, `Authorization: Bearer <access_token>` on every endpoint except register, login,
refresh and `/healthz`.

### 5.1 Errors
Every non-2xx response has this body (FastAPI's default 422 and 404/405 are converted to it too):
```json
{"error": {"code": "username_taken", "message": "Human readable text", "details": {}}}
```
| Code | Status | Meaning |
|---|---|---|
| `validation_error` | 422 | Body/query invalid; `details.fields` maps field → message (at most 20 fields; `details.omitted_fields` counts the rest). Bodies with far more keys than the model has are refused before validation (`details.fields.body = "has too many fields"`). |
| `unauthorized` | 401 | Missing/invalid/expired access token. |
| `invalid_credentials` | 401 | Wrong username/password (same for unknown users). |
| `invalid_refresh_token` | 401 | Unknown, expired or reused refresh token. |
| `device_revoked` | 401 | The token's device has been revoked. |
| `forbidden` | 403 | Generic. |
| `not_friends` | 403 | Target user is not a friend. |
| `device_not_linked` | 403 | Calling device has no certificate and the action needs one. |
| `not_found` | 404 | |
| `username_taken`, `already_friends`, `request_exists`, `identity_exists`, `device_key_in_use` | 409 | |
| `too_many_devices` | 409 | 10 active devices already; `details.devices` lists them (id, name, last_seen_at). |
| `stale_devices` | 409 | `details.stale_device_ids` (unknown/revoked/ineligible), `details.missing_device_ids` (§5.3 completeness). |
| `cannot_friend_self`, `invalid_image`, `invalid_public_key`, `invalid_certificate` | 400 | |
| `payload_too_large` | 413 | |
| `rate_limited` | 429 | `Retry-After` header set. |
| `internal_error` | 500 | Never leaks internals. |
| `method_not_allowed` | 405 | `Allow` header set. |
| `service_unavailable` | 503 | `/healthz` only, when MongoDB is unreachable. |

### 5.2 Shapes
```
User       = {"id", "username", "avatar_url": absolute URL | null}
Me         = User + {"identity_key": b64 | null}
MyDevice   = {"id", "name", "public_key", "certificate": b64|null, "created_at", "last_seen_at", "current": bool}
PeerDevice = {"id", "public_key", "certificate"}
DeviceInfo = {"id", "user_id", "public_key", "certificate": b64|null, "revoked_at": ISO|null}
FriendRequest = {"id", "from_user": User, "to_user": User, "created_at"}
Envelope   = {"id", "sender_user_id", "sender_device_id", "recipient_device_id", "nonce", "ciphertext", "created_at"}
Tokens     = {"access_token", "refresh_token", "token_type": "bearer", "expires_in": seconds}
```
`avatar_url` is absolute: `FIXES_PUBLIC_BASE_URL + "/media/avatars/<key>.jpg"` (local backend) or
`FIXES_S3_PUBLIC_BASE_URL + "/avatars/<key>.jpg"` (S3; public-read bucket or CDN, never presigned).

### 5.3 Endpoints

**Health**
- `GET /healthz` → 200 `{"status":"ok"}`; pings MongoDB, 503 if down.

**Auth**
- `POST /v1/auth/register` `{username, password}` → 201 `{"user": User}`. 409 `username_taken`.
- `POST /v1/auth/login` `{username, password, device: {name (1–64), public_key (b64, 32 bytes)}}` → 200
  `Tokens + {"user": Me, "device": MyDevice}`. Creates a new (unlinked) device. Errors: 401 `invalid_credentials`
  (unknown users run a dummy argon2 verify so timing matches), 400 `invalid_public_key` (not 32 bytes, or an X25519
  low-order point — the server rejects keys for which X25519 with a fixed random scalar gives all zeros), 409
  `device_key_in_use`, 409 `too_many_devices`, 429 `rate_limited`. Sends `devices_changed` to the user's other sockets.
- `POST /v1/auth/refresh` `{refresh_token}` → 200 `Tokens`. Atomic rotation:
  `find_one_and_update({_id: sha256(token), used_at: null, expires_at: {$gt: now}}, {$set: {used_at: now, replaced_by: <new hash>}})`.
  If that matches nothing and the token exists, is already used, its `used_at` is < 60 s ago and its successor is still
  unused → treat as a client retry: mark the successor used and issue a fresh pair (grace). Any other reuse → revoke
  the device (§5.4) and 401 `invalid_refresh_token`. A completed revocation deletes the device's refresh tokens, so a
  later refresh gets 401 `invalid_refresh_token`; `device_revoked` is returned to authenticated calls made with a
  still-valid access token (and to refresh only if a revocation was interrupted). Clients treat both alike (§6).
  Every new refresh token
  gets a fresh 30-day expiry (sliding). Expiry is checked explicitly (the TTL index is only cleanup).
- `POST /v1/auth/logout` → 204. Revokes the current device.
- `POST /v1/auth/password` `{current_password, new_password}` → 204. Revokes **all other** devices.
- `POST /v1/auth/reset-identity` `{password, identity_key, device_certificate}` → 200 `{"user": Me}`. For a user who lost
  every linked device: verifies the password, revokes all other devices, replaces `users.identity_key`, stores the
  current device's certificate (verified against the new key). Contacts will see a safety-code change.

**Identity & devices**
- `PUT /v1/users/me/identity` `{identity_key, device_certificate}` → 200 `{"user": Me}`. Only when
  `users.identity_key` is null (else 409 `identity_exists`); certifies the current device.
- `PUT /v1/devices/{device_id}/certificate` `{certificate}` → 200 `MyDevice`. The device must belong to the caller and
  be active; the certificate must verify under `users.identity_key` (400 `invalid_certificate`). Used by a linked
  device to certify a new one during linking. This endpoint, `PUT /v1/users/me/identity` and
  `POST /v1/auth/reset-identity` send `devices_changed` to all of the user's connected sockets.
- `GET /v1/devices` → 200 `{"devices": [MyDevice]}` — caller's active devices, linked or not.
- `DELETE /v1/devices/{device_id}` → 204 — revoke one of the caller's own devices (404 otherwise).
- `GET /v1/users/{user_id}/devices` → 200 `{"identity_key": b64|null, "devices": [PeerDevice]}` — active **linked**
  devices only. Allowed for self and friends; others 403 `not_friends`; 404 unknown user.
- `GET /v1/users/{user_id}/devices/{device_id}` → 200 `DeviceInfo` — any state, including revoked (device documents
  are never deleted). Same access rule.

**Users**
- `GET /v1/users/me` → 200 `Me`.
- `GET /v1/users?q=<1–30 chars [A-Za-z0-9_]>` → 200 `{"users": [User]}`: case-insensitive substring match on
  `username_lower` (regex-escaped), excludes the caller, max 20, ordered by username. Invalid `q` → 422 (the app
  validates before calling).
- `GET /v1/users?ids=<comma-separated, 1–100 uuids>` → 200 `{"users": [User]}` (unknown ids omitted) — used to refresh
  peer names/avatars. `q` and `ids` are mutually exclusive; neither → 422.
- `GET /v1/users/{user_id}` → 200 `User`; 404.
- `PUT /v1/users/me/avatar` multipart field `image` → 200 `{"user": Me}`. Pipeline: reject `Content-Length` > 5 MiB
  and count streamed bytes (413); `Image.open(f, formats=["JPEG","PNG","WEBP"])`; header size check ≤ 8192 px per side
  and ≤ 25 Mpx before decoding; `Image.MAX_IMAGE_PIXELS = 25_000_000` with `DecompressionBombWarning` as error; JPEG
  `draft("RGB", (1024, 1024))`; first frame only; `ImageOps.exif_transpose`; `convert("RGB")`; `thumbnail((512, 512))`;
  save JPEG quality 85 without EXIF/ICC; new random object key; delete the old object. Any decode failure → 400
  `invalid_image`. Runs in the worker pool.

**Friends**
- `GET /v1/friends` → 200 `{"friends": [User]}` ordered by username.
- `DELETE /v1/friends/{user_id}` → 204; 404 if not friends.
- `GET /v1/friend-requests` → 200 `{"incoming": [FriendRequest], "outgoing": [FriendRequest]}`.
- `POST /v1/friend-requests` `{to_user_id}` → 201 `{"status":"pending","friend_request": FriendRequest}` or 200
  `{"status":"accepted","friend": User}` when the target had already requested the caller. 404, 400
  `cannot_friend_self`, 409 `already_friends`, 409 `request_exists`.
- `POST /v1/friend-requests/{id}/accept` → 200 `{"friend": User}`. Only the recipient; anyone else 404.
  Write order: insert friendship with `_id = pair_key` (duplicate key = success), then delete the request.
- `DELETE /v1/friend-requests/{id}` → 204. Decline (recipient) or cancel (sender); others 404.

**Envelopes**
- `POST /v1/envelopes` `{"envelopes": [{recipient_device_id, nonce, ciphertext}] (1–100), "complete_for_user_ids": [uuid] (optional, ≤ 2)}`
  → 201 `{"ids": [id | null], "created_at": ISO, "dropped_device_ids": [..]}`. Rules, all checked before anything is
  stored (all-or-nothing except mailbox overflow):
  - sender user/device come from the token, never the body; one `created_at` for the whole batch;
  - decoded nonce must be 24 bytes (422); decoded ciphertext at least 16 bytes (422) and at most 65 536 bytes (413);
  - every recipient device must exist and be active; if it belongs to another user, that user must be a friend
    (403 `not_friends`), the recipient device must be linked, and the sending device must be linked (403
    `device_not_linked`); unknown/revoked/unlinked-foreign recipients → 409 `stale_devices` (`stale_device_ids`);
  - completeness: for each user id in `complete_for_user_ids`, the batch must target every active linked device of
    that user except the sending device; otherwise 409 `stale_devices` with `missing_device_ids`;
  - mailbox caps: a recipient device holds at most 5 000 pending envelopes, and at most 1 000 from any single *other*
    user. Envelopes that would exceed a cap are not stored (`ids[i] = null`), their device ids are returned in
    `dropped_device_ids`, and the device gets `overflow_at` set (reported once as `gap: true`, §6 and below);
  - stored envelopes are pushed live to connected recipient devices.
- `GET /v1/envelopes?limit=1..500` (default 100) → 200 `{"envelopes": [Envelope], "gap": bool}` — pending envelopes for
  the current device in id order (oldest first). A page also ends once it holds about 4 MiB of ciphertext (it always
  contains at least one envelope when any is pending). `gap` is true once after the device overflowed, then cleared.
- `POST /v1/envelopes/ack` `{"ids": [..]}` (1–500) → 204. Deletes those ids addressed to the current device; others
  ignored.

### 5.4 Device lifecycle and revocation
- `last_seen_at` is updated on login, refresh, WebSocket auth, and at most once per hour on other authenticated calls.
- Idle sweep (at startup and hourly): devices whose `last_seen_at` is older than `FIXES_DEVICE_IDLE_DAYS` (default 30
  = refresh-token lifetime = envelope TTL) are revoked — they can never authenticate again.
- Revocation (logout, `DELETE /v1/devices/{id}`, password change, identity reset, refresh-token reuse, idle sweep), in
  this order, idempotent: set `revoked_at` (every authenticated request checks it) → delete its refresh tokens → delete
  its pending envelopes → close its WebSocket (4401) → send `devices_changed` to the user's remaining sockets.
- At most 10 active devices per user (login → 409 `too_many_devices`).

### 5.5 Tokens and passwords
- Access token: JWT HS256, claims `sub` (user id), `did` (device id), `typ: "access"`, `iat`, `exp`; lifetime 15 min.
- Refresh token: 32 random bytes, base64url; stored only as SHA-256 hex; lifetime 30 days (sliding); one-time use with
  the 60 s retry grace above.
- `FIXES_JWT_SECRET` is required (≥ 32 chars); the server refuses to start without it.
- Passwords: argon2id via argon2-cffi with `time_cost=3, memory_cost=65536 (KiB), parallelism=1`; rehash on login if
  parameters change.

### 5.6 Rate limits (in memory, token buckets; 429 `rate_limited` with `Retry-After`)
| What | Limit |
|---|---|
| Register | 5 / hour / IP |
| Login failures | 10 / 15 min per (username_lower, IP); 50 / hour per IP across usernames (unknown usernames count the same) |
| Successful password checks (login, password change, identity reset) | 30 / hour / username |
| Refresh | 30 / hour / device |
| Envelopes POST | 600 / min / user |
| User search / ids lookup | 60 / min / user |
| Friend requests (create) | 50 / day / user |
| Avatar upload | 10 / hour / user |
| WebSocket connects | 20 / min / IP; ≤ 20 concurrent unauthenticated sockets per IP |

Client IP = socket peer, or the forwarded client when Uvicorn runs with `--proxy-headers` and
`FORWARDED_ALLOW_IPS` set to the proxy's address. IPv6 clients are keyed by their /64 prefix (IPv4-mapped addresses
count as IPv4). Limits run before any password hashing.

### 5.7 Request size limits
ASGI middleware rejects by `Content-Length` and by counting streamed bytes (413 `payload_too_large`): 9 MiB for
`POST /v1/envelopes`, 5.5 MiB for the avatar upload, 64 KiB for everything else. The large budgets apply only to
requests whose access token verifies (otherwise 401 before any body byte is read). Uvicorn runs with
`--ws-max-size 65536`.

Concurrency caps (429 `rate_limited`, `Retry-After: 1`; clients wait and retry):
- `POST /v1/envelopes` and the avatar upload: at most 4 requests in flight per account.
- Envelope batches over 64 KiB are parsed at most 2 at a time server-wide; a batch still waiting for a slot after
  10 s gets the 429. A response the client stops reading while it holds a slot is abandoned after 5 s.
- `GET /v1/envelopes`: at most 2 pages in flight per device; a page the client stops reading for 30 s is abandoned.

## 6. WebSocket `/v1/ws`

1. Client connects (no token in the URL) and sends within 10 s `{"type":"auth","token":"<access token>"}`.
2. Server replies `{"type":"ready","gap": bool}`. Pending envelopes are **not** replayed on the socket; the client
   drains them with `GET /v1/envelopes`.
3. Server → client: `{"type":"envelope","envelope": Envelope}`, `{"type":"devices_changed"}`, `{"type":"pong"}`.
4. Client → server: `{"type":"ping"}` (every 25 s), `{"type":"ack","ids":[..]}` (same semantics as REST ack).
5. One socket per device: a new authenticated socket closes the older one with 4409 (by connection order, so a slow,
   abandoned handshake never replaces a newer socket).
6. The 10 s auth timeout is configurable with `FIXES_WS_AUTH_TIMEOUT_SECONDS`.

| Close code | Meaning | Client reaction |
|---|---|---|
| 4401 | Bad token, or device revoked | Refresh once (single-flight); if refresh fails with `device_revoked`/`invalid_refresh_token` → signed-out state ("This device was signed out"), delete session + device key, keep local data. Otherwise reconnect. |
| 4408 | Auth timeout | Reconnect with backoff. |
| 4409 | Replaced by a newer socket for this device | Do not reconnect until the app next returns to the foreground. |
| 1003, 1008, 1009, 1011, 1012, 1013 | Binary frame; non-JSON, over-nested or out-of-order frame (first frame not `auth`); frame over 64 KiB; server error; server shutdown; slow consumer | Same as "other". |
| other / network error | | Reconnect with exponential backoff 1 s → 30 s with jitter. |

## 7. Encrypted payloads (inside envelope ciphertext)

UTF-8 JSON objects with `"v": 1` and a `"kind"`. Unknown kinds/versions are acked and ignored. Clients validate every
field (types, lengths, uuid format, timestamps) before using it; any violation = permanent failure (§13).

### 7.1 `message`
```json
{"v":1,"kind":"message","id":"<uuid>","from":"<user id>","to":"<user id>","body":"<1–4000 chars>","sent_at":1731492000000}
```
Encrypted for every linked device of `to` and every other linked device of `from` (POST with
`complete_for_user_ids: [to, from]`). Self-chat is not allowed. Rules on receipt (`me` = my user id):
- From another user: require `from == envelope.sender_user_id`, `to == me`, `from != me`. Store as incoming
  (`direction=in`, `status=received`) in the conversation with peer `from`.
- Sync copy: require `from == me == envelope.sender_user_id`, `to != me`, `envelope.sender_device_id != my device`.
  Store as outgoing (`direction=out`, `status=sent`) in the conversation with peer `to`.
- Anything else → drop. `sent_at` is display-only; ordering uses `server_ts = envelope.created_at` (§12).

### 7.2 `receipt`
```json
{"v":1,"kind":"receipt","status":"delivered"|"read","peer":"<user id>","message_ids":["<uuid>",..],"at":1731492000000}
```
`peer` is the other party of the conversation, seen from the user who generated the receipt. 1–500 ids per receipt.
- `delivered`: generated only for messages this device actually inserted (not duplicates, not imports); sent to all
  linked devices of the original sender.
- `read`: generated only for incoming rows this device changed `received → read` because the user viewed them here
  (never because of read sync or imports); sent to all linked devices of the original sender **and** the reader's other
  linked devices.
- Coalesced per (peer, status) with ~1 s debounce; queued in the outbox and retried like messages.
- Applying: from another user X → update only rows with `peer_user_id = X AND direction = 'out' AND id IN (...)`;
  from my own device → only rows with `peer_user_id = payload.peer AND direction = 'in'` (read sync; clears unread).
  Unknown ids → stored in `receipt_hints` and applied when the message row appears. Statuses only move forward.

### 7.3 `link` and `history` (device linking, §9)
Both carry an inner sealed box keyed by the transfer secret from the QR code (never sent over the network):
```json
{"v":1,"kind":"link"|"history","transfer_id":"<uuid>","attempt_id":"<uuid>","seq":0,"total":3,"nonce":"<b64 24>","sealed":"<b64>"}
```
`sealed = XChaCha20-Poly1305(transfer_key, nonce).encrypt(UTF-8(JSON(inner)), aad=UTF-8("fixes/v1/" + kind + "|" + transfer_id + "|" + attempt_id + "|" + seq + "|" + total))`.
- `link` inner (sent first, `seq = 0`, `total = 1`): `{"identity_public_key","identity_secret_key"}` — B checks the
  public half equals the server's `users.identity_key` and that the secret matches it.
- `history` inner: `{"conversations":[Conv], "messages":[Msg], "contact_identities":[Ident]}`, each chunk's inner JSON
  ≤ 48 000 bytes.
Accepted only if `envelope.sender_user_id == me`, `transfer_id` matches an open transfer on this device and the sealed
box opens. `Conv = {"peer_user_id","peer_username","peer_avatar_url"}`;
`Msg = {"id","peer_user_id","direction":"in"|"out","sender_user_id","body","sent_at","server_ts","status"}`;
`Ident = {"user_id","identity_key","first_seen_at","verified"}`. System messages are never exported.

## 8. Trust: identity pinning and device eligibility

- The app pins each contact's AIK on first use in `contact_identities` (TOFU). Its own AIK comes from login/identity.
- **Eligible devices** for encryption and decryption of user U = devices the server reports for U whose certificate
  verifies under U's pinned AIK. Uncertified or wrongly certified devices are ignored (never encrypted to; envelopes
  from them dropped). Own sync copies follow the same rule with the user's own AIK.
- Device lists are cached for 60 s per user; invalidated by a `stale_devices` 409 (the send is retried once with fresh
  lists), by `devices_changed` (own list), and on every WebSocket (re)connect (own list).
- **AIK change** for a contact (they reset their identity): store it as `pending_identity_key`, insert a system message
  ("<username>'s safety code changed"), and block sending to that contact until the user taps **Accept** on the
  conversation banner (then the new key is pinned, `verified = 0`). Incoming messages certified by the pending key are
  shown below the warning.
- **Own account**: a newly logged-in device of mine shows up on the Devices screen as "Not linked" until linked; a
  linked device I did not expect can be revoked there.
- Scanning a link QR marks the user's own new device as verified locally; comparing safety codes (§4.4) and tapping
  "Mark as verified" sets `verified = 1` for a contact.

## 9. Device linking and history transfer

1. After login the app decides the device state from `user.identity_key` and secure storage:
   - `identity_key` null → first device: generate AIK, `PUT /v1/users/me/identity` (self-certified). Linked.
   - `identity_key` set and this install holds the matching AIK secret (re-login on the same phone) → self-certify with
     `PUT /v1/devices/{id}/certificate`. Linked.
   - Otherwise → **"Link this device"** screen: shows the QR, with a secondary "I lost my other devices — reset my
     security identity" path (warning: contacts will see a safety-code change; requires the password).
2. New device B shows the QR `fixes-link:1:<transfer_id>:<B device id>:<B X25519 public key b64url>:<transfer_key b64url (32 bytes)>`,
   storing transfer_id + transfer_key in `history_transfers`.
3. Linked device A → Settings → "Link a new device" scans it, fetches `GET /v1/devices`, requires B to be listed
   **with exactly the QR's public key**, certifies B (`PUT /v1/devices/{B}/certificate`), then sends one `link`
   envelope.
4. A drains its own mailbox, takes a snapshot (one read transaction), keeps the screen awake, and sends `history`
   chunks (new `attempt_id` per attempt) in `POST /v1/envelopes` batches, showing progress. On 401/409 for B it aborts
   with a visible error; after an interruption it offers **Resend** (new attempt, same QR while still valid).
5. B binds the transfer to the first (sender device, attempt_id) it sees; a new attempt from the same device resets
   `total`/`received_seqs` (already imported rows stay); chunks from other devices are ignored. Complete when seqs
   `0..total-1` of one attempt arrived. Expiry: 30 min to the first chunk, then 10 min of inactivity → "Transfer
   incomplete, retry". On completion the transfer key is deleted.
6. Import is idempotent and merges as in §10. Linking without history (A has none) still sends `link` + one empty
   `history` chunk.

## 10. Backups

File `fixes-backup-<username>-<YYYYMMDD-HHmm>.fixes`:
```json
{"format":"fixes-backup","version":1,"user_id":"<uuid>","created_at":"<ISO>",
 "kdf":{"name":"hkdf-sha256","salt":"<b64 16>"},"cipher":"xchacha20poly1305","nonce":"<b64 24>","ciphertext":"<b64>"}
```
`backup_body = {"conversations":[Conv], "messages":[Msg], "contact_identities":[Ident]}` (shapes from §7.3).
- Export: on first use generate/confirm the recovery key (§4.3); write the file to the cache directory; open the share
  sheet; delete the cache copy afterwards.
- Import: `DocumentPicker` with type `*/*`, copy to cache; check `format`, `version == 1`, `cipher`, `kdf.name`; refuse
  a backup whose `user_id` differs from the logged-in user; ask for the recovery key; decrypt (wrong key → clear error,
  nothing changed); merge in one transaction.
- Merge rules (history import too): messages `INSERT OR IGNORE`, on conflict keep the highest status
  (out: `failed < pending < sent < delivered < read`; in: `received < read`); imported `pending` rows become `failed`
  (never auto-sent); imported incoming rows from a backup are marked `read`; conversation rows are inserted only when
  missing (then names/avatars are refreshed via `GET /v1/users?ids=`); contact identities: an existing pin wins, a
  conflicting key is reported to the user, never imported; `receipt_hints` are applied afterwards.
- Rows must be consistent: `direction ∈ {in,out}`, status valid for the direction, `sender_user_id == me` for out and
  `== peer_user_id` for in; invalid rows are skipped and counted.

## 11. Server data model (MongoDB)

| Collection | Document | Indexes |
|---|---|---|
| `users` | `_id`, `username`, `username_lower`, `password_hash`, `identity_key` (nullable), `avatar_key` (nullable), `created_at` | unique `username_lower` |
| `devices` | `_id`, `user_id`, `name`, `public_key`, `certificate` (nullable), `created_at`, `last_seen_at`, `revoked_at` (nullable), `overflow_at` (nullable) | `user_id`; unique `public_key`; `last_seen_at` |
| `refresh_tokens` | `_id` (SHA-256 hex), `user_id`, `device_id`, `created_at`, `expires_at`, `used_at` (nullable), `replaced_by` (nullable) | `device_id`; TTL on `expires_at` |
| `friend_requests` | `_id`, `from_user_id`, `to_user_id`, `pair_key`, `created_at` | unique `pair_key`; `to_user_id`; `from_user_id` |
| `friendships` | `_id` (= `pair_key`), `user_ids` [a, b], `created_at` | `user_ids` |
| `envelopes` | `_id` (ObjectId), `recipient_device_id`, `recipient_user_id`, `sender_user_id`, `sender_device_id`, `nonce`, `ciphertext`, `size`, `created_at`, `expires_at` | (`recipient_device_id`, `_id`); (`recipient_device_id`, `sender_user_id`); TTL on `expires_at` |

`pair_key` = the two user ids sorted and joined with `:`. Envelope TTL `FIXES_ENVELOPE_TTL_DAYS` (default 30). Indexes
are created idempotently at startup. Devices are never deleted (needed for §4.2 key lookup of revoked devices).

## 12. App local storage

### 12.1 Platform storage rules
- SQLite via expo-sqlite with **SQLCipher** (`useSQLCipher: true` in the expo-sqlite config plugin). Key: 32 random
  bytes (hex) in secure storage `fixes.dbkey.<user_id>`, applied with `PRAGMA key` right after opening; the app refuses
  to continue if `PRAGMA cipher_version` is empty. If the DB file exists but its key is missing (restored from an OS
  backup), the file is moved aside and the app starts empty, offering backup import and device linking.
- Every secure-storage item uses `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`:
  `fixes.session` → `{user_id, device_id, refresh_token}`; `fixes.device.<user_id>` → `{device_id, public_key, secret_key}`;
  `fixes.identity.<user_id>` → `{public_key, secret_key}`; `fixes.dbkey.<user_id>`; `fixes.backupkey.<user_id>`.
  The access token lives in memory only.
- `app.json`: `android.allowBackup: false`.
- Logout keeps local data (DB, DB key, identity, recovery key) for the next login on this phone. Settings offers
  **Erase this device**: deletes the DB file and every secure-storage item of the user.

### 12.2 Schema (one file per user: `fixes-<user_id>.db`, `PRAGMA user_version = 1`)
```sql
CREATE TABLE conversations (
  peer_user_id         TEXT PRIMARY KEY,
  peer_username        TEXT NOT NULL,
  peer_avatar_url      TEXT,
  last_activity_at     INTEGER NOT NULL,          -- max sort_ts of non-system messages
  unread_count         INTEGER NOT NULL DEFAULT 0,
  profile_refreshed_at INTEGER
);
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,               -- chosen by the original sender; system messages: random uuid
  peer_user_id   TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('in','out','system')),
  sender_user_id TEXT,                            -- NULL for system messages
  body           TEXT NOT NULL,
  sent_at        INTEGER NOT NULL,                -- sender clock, display only
  server_ts      INTEGER,                         -- envelope created_at / POST response; NULL while pending
  sort_ts        INTEGER NOT NULL,                -- server_ts when known, else local creation time
  received_at    INTEGER,
  status         TEXT NOT NULL                    -- out: pending|sent|delivered|read|failed; in: received|read; system: none
);
CREATE INDEX messages_by_conversation ON messages(peer_user_id, sort_ts, id);
CREATE TABLE outbox (                             -- this device's work; never exported
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('message','receipt')),
  message_id      TEXT,                           -- kind = message
  payload         TEXT,                           -- kind = receipt: JSON {peer, status, message_ids}
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE TABLE receipt_hints (
  message_id TEXT PRIMARY KEY, status TEXT NOT NULL, at INTEGER NOT NULL   -- pruned after 30 days
);
CREATE TABLE contact_identities (
  user_id              TEXT PRIMARY KEY,
  identity_key         TEXT NOT NULL,
  first_seen_at        INTEGER NOT NULL,
  verified             INTEGER NOT NULL DEFAULT 0,
  pending_identity_key TEXT
);
CREATE TABLE history_transfers (
  transfer_id      TEXT PRIMARY KEY,
  transfer_key     TEXT,                           -- deleted (NULL) when complete
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  sender_device_id TEXT,
  attempt_id       TEXT,
  total            INTEGER,
  received_seqs    TEXT NOT NULL DEFAULT '[]',
  completed_at     INTEGER
);
```

## 13. App message lifecycle

- **Send**: insert the message (`direction=out`, `status=pending`, `sort_ts=now`) and an outbox row in one transaction.
  The outbox worker (runs when the socket is ready, on foreground, and after enqueue) resolves eligible devices (§8),
  encrypts one envelope per device, POSTs with `complete_for_user_ids`, then sets `server_ts`/`sort_ts` from the
  response, moves status forward to `sent` (never backwards) and deletes the outbox row. Errors: network/5xx → retry
  with backoff (1 s → 5 min); `stale_devices` → refresh lists, retry once immediately; `not_friends`, contact identity
  pending acceptance, or no eligible recipient devices → `failed` (tap to retry); `rate_limited` → wait `Retry-After`.
- **Receive**: a single queue. On `ready`: buffer pushed envelopes; drain `GET /v1/envelopes` page by page until empty,
  applying each page in one SQLite transaction then acking the page; then process buffered pushes, skipping envelope ids
  already applied this session. Only one drain runs at a time. Apply is idempotent: message rows `INSERT OR IGNORE`,
  and conversation summary, unread count and delivered receipts change only when a row was actually inserted.
  Errors: permanent (decrypt/validation failure, ineligible sender device, unknown kind) → ack and drop, and for an
  undecryptable message from a known contact show a system message "A message from <username> could not be
  decrypted". Consecutive failures from the same contact collapse into that one notice, which then counts them
  ("<n> messages from <username> could not be decrypted"); a new notice starts only after a message from that
  contact was stored successfully. Like every system message, it never changes `unread_count` or
  `last_activity_at`. Transient (network/5xx while resolving keys) → stop the queue without acking and retry with
  backoff.
  An unknown peer gets a conversation row with a placeholder name; its profile is fetched in the background.
- **Gap**: `gap: true` (on `ready` or `GET /v1/envelopes`) shows "This device missed some messages — link it again
  from another device to recover history".
- **Inbox refresh**: when the inbox gains focus (at most once a minute) and after imports, peers' names/avatars are
  refreshed with `GET /v1/users?ids=`. Images fall back to a placeholder on load error.
- **Logout**: requires connectivity; drain the mailbox, flush the outbox (warn if items remain), `POST /v1/auth/logout`,
  then delete `fixes.session` and `fixes.device.<user_id>`.

## 14. Screens and legacy parity

| Legacy | v2 |
|---|---|
| Login (logo, username, password, "Create account") | Same. "No internet connection" error kept. |
| Register → toast "Welcome to Fixes <username>, please login to continue!" → back to Login | Same toast text, then logs in automatically. |
| Tabs: Home (placeholder), New Post (avatar via camera), Discover, Messages, Profile | Tabs: Messages, Discover, Profile (black bar, white selected / 40 % white unselected icons). |
| Inbox: avatar, username, preview, arrow → (outgoing) / ← (incoming), relative time, bold when last message is incoming and unread, sorted by last activity, search bar, black FAB → New conversation | Same. Arrow colour: incoming Gray; outgoing read Orange, delivered Blue, sent LightGray, pending Red, failed Red + retry icon. Preview/arrow/colour come from the newest non-system message. Search bar filters by username locally. |
| New conversation: friends list with search | Same. |
| Conversation: bubbles right (mine) / left, title = peer username, entry + Send, camera button (did nothing) | Same minus camera button; status ticks on my bubbles; safety-code banner when needed; tap failed message to retry. |
| Discover → Search users (submit to search) | Same; validates `[A-Za-z0-9_]{1,30}` before calling; excludes yourself; max 20 results. |
| Profile (me): avatar, username, Log Out, Edit (camera / library, preview, Save) | Same + Settings (Devices, Link a new device, Backups, Erase this device). Avatar is square-cropped, resized to ≤ 1024 px JPEG 0.8 before upload. |
| Profile (other): "Add as known" (wired to Log Out by mistake), "Message" | "Add friend" / "Request sent" / "Accept request" / "Friends"; "Message" only for friends; "Security" (safety code). |
| — | Friend requests screen (incoming accept/decline, outgoing cancel). |
| Debug "Copiar BDD" button | Removed; replaced by encrypted backups. |

Relative time thresholds follow legacy `DateTimeUtils.RelativeTime` ("x seconds ago", "a minute ago", "x minutes ago",
"an hour ago", "x hours ago", "yesterday", "x days ago", "x months ago", "x years ago").

## 15. What servers can see and keep (tell users and operators)

- **Never**: message bodies, receipts' contents, history, backups, device secret keys, identity secret keys, the
  transfer secret, the recovery key.
- **Transiently**: ciphertext envelopes with sender/recipient user and device ids, timestamps and sizes (padded to
  256-byte buckets), until acked or for at most 30 days. Deleted documents can survive in MongoDB's oplog (replica
  sets) and in host/Atlas snapshots for their retention period; with no forward secrecy, a later theft of a device
  secret key could decrypt such copies (history transfers have an extra layer keyed by the QR secret, which is deleted
  after the transfer). Operators should keep oplog windows small and exclude the database from long-lived snapshots
  where possible, and must never log request bodies or tokens.
- **Persistently**: accounts (username, password hash, avatar, identity public key), devices (name, public key,
  certificate, last seen, revocation time), friendships and pending requests.
- **Metadata**: who talks to whom and when, approximate message sizes, receipt timing, device counts, last-seen times,
  client IP addresses in access logs.
- **Outside the Fixes server**: backup files go wherever the user saves them (iCloud Drive, Google Drive, e-mail…),
  protected by a 120-bit recovery key. OS backups contain only SQLCipher ciphertext whose key never leaves the phone.
  Revoking a lost phone remotely does not erase the history already on it.
