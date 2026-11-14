# fixes-server

The Python backend of **Fixes v2**, a hobby end-to-end-encrypted chat app. It stores accounts,
profiles with avatars, friendships and a directory of device public keys, and relays opaque
ciphertext envelopes between devices (REST mailbox plus live WebSocket pushes). It never sees
message contents: encryption happens on the phones. The contract with the app is
[`../docs/protocol.md`](../docs/protocol.md); section numbers (§) below refer to it.

Implemented: every endpoint of §5.3 (health, auth, identity and devices, users, avatars,
friends, envelopes), the `/v1/ws` WebSocket of §6, device revocation and the idle-device sweep
(§5.4), the rate limits of §5.6, the size limits of §5.7 and the MongoDB model of §11.

## Architecture

```
src/fixes_server/
  main.py          create_app(settings) + lifespan; app_from_env() is the Uvicorn factory
  config.py        Settings (pydantic-settings, FIXES_* env vars); load_settings() fails fast
  context.py       AppContext: Mongo client, collections, worker limiter, services (app.state.ctx)
  deps.py          get_context, authenticate_access_token(), CurrentPrincipal dependency
  errors.py        ApiError + handlers forcing every error into the §5.1 body
  middleware.py    pure ASGI guards: BodySizeLimitMiddleware (§5.7, plus the concurrency
                   caps of the large-body routes) and EnvelopePageMiddleware (paced GET
                   /v1/envelopes pages)
  ratelimit.py     TokenBucketLimiter, KeyedConcurrencyLimiter, RateLimiters, client_ip(),
                   client_ip_key() (IPv6 clients by /64)
  hooks.py         DeviceEventHooks interface (envelope cleanup, socket close, devices_changed)
  locks.py         KeyedLocks: per-device locks that make the mailbox caps exact
  ids.py           UUIDv4 ids, pair keys, MonotonicObjectIds (envelope ids)
  db.py            typed collections + idempotent index creation (§11)
  documents.py     TypedDicts of every stored document
  blocking.py      run_blocking(): worker threads behind CapacityLimiter(4) (§2)
  images.py        avatar pipeline (Pillow, runs in the worker pool)
  storage.py       avatar storage: local filesystem (served at /media) or S3 (boto3)
  security/        argon2id passwords, JWT access tokens, refresh-token primitives,
                   X25519/Ed25519 validation
  services/        business logic (accounts, sessions, devices, identity, revocation,
                   users, friends, directory, avatars, envelopes, idle_sweep, presenters)
  realtime/        the WebSocket layer: protocol (frames, close codes), connections
                   (ConnectionManager, per-socket queues), hooks (RealtimeHooks), session
                   (the per-socket protocol)
  routers/         one module per API area (health, auth, devices, users, friends,
                   envelopes, ws)
  models/          Pydantic request/response bodies (§5.2)
```

* **One process.** Rate limits, live sockets, realtime fan-out and the mailbox locks are in
  memory, so run a single API instance (one Uvicorn worker). CPU or blocking work (argon2,
  Pillow, boto3, file writes) runs in worker threads behind one `anyio.CapacityLimiter(4)`.
* **MongoDB without transactions.** Multi-step writes use crash-safe orders: refresh-token
  rotation stores the successor before consuming the old token, friendships are inserted (with
  `_id = pair_key`, so a duplicate means "done") before requests are deleted, avatars are uploaded
  before the user points at them, envelope batches set `overflow_at` before inserting, password
  changes revoke the other devices before writing the new hash (and again after it), and
  revocation follows the §5.4 order.
* **Revocation** (`services/revocation.py`) sets `revoked_at`, deletes refresh tokens, deletes
  the device's pending envelopes, closes its socket with 4401 and sends `devices_changed` to the
  user's remaining sockets. Every step is idempotent: a refresh attempt with a token that
  survived an interrupted revocation finishes it, and so does a later revocation of the device
  or, if the device still has pending envelopes, the next idle sweep.
* **Lifecycle hooks.** REST handlers call `ctx.hooks` (`hooks.py`); the real implementation is
  `realtime/hooks.py`. `create_app(settings, hooks=...)` chains an extra observer after it,
  which is how the tests record events.
* **Background work.** The lifespan runs the idle-device sweep in an anyio task group (at
  startup, then hourly) and cancels it on shutdown, after asking every open socket to close
  with 1012.

## Envelopes (§5.3)

| Endpoint | Result |
|---|---|
| `POST /v1/envelopes` `{"envelopes": [{recipient_device_id, nonce, ciphertext}] (1-100), "complete_for_user_ids": [uuid] (0-2)}` | 201 `{"ids": [id or null], "created_at", "dropped_device_ids"}` |
| `GET /v1/envelopes?limit=1..500` (default 100) | 200 `{"envelopes": [Envelope], "gap": bool}`, oldest first; a page also ends once it holds 4 MiB of ciphertext (always at least one envelope), so clients drain until a page is empty. At most 2 pages per device are in flight (see below) |
| `POST /v1/envelopes/ack` `{"ids": [..]}` (1-500) | 204; deletes only envelopes addressed to the calling device |

A batch is checked completely before anything is stored, in this order (the first failing rule
answers):

1. body shape (422): canonical padded base64, nonce exactly 24 bytes, ciphertext at least 16
   bytes (the Poly1305 tag), recipient ids are UUIDv4, and no unknown fields, so a body can
   never name a sender (sender user and device always come from the access token). Unknown
   fields are named in `details.fields`, but an object (the batch or one of its envelopes)
   with more than 10 keys beyond its fields is refused whole, right after JSON decoding, as
   `{"body": "has too many fields"}`: validating it would build one error per key;
2. any ciphertext over 65 536 bytes: 413 `payload_too_large`;
3. rate limit: 600 POSTs per minute per user (429);
4. `not_friends` (403) if a known recipient device or a `complete_for_user_ids` entry belongs to
   another user who is not a friend (checked before anything that could reveal a non-friend's
   device ids);
5. `device_not_linked` (403) if the sending device has no certificate and any recipient belongs
   to another user (unlinked devices may still write to their own account's devices, which is
   how a new device receives its link envelope);
6. `stale_devices` (409) with both `stale_device_ids` (unknown, revoked, or another user's
   unlinked device) and `missing_device_ids` (active linked devices of a
   `complete_for_user_ids` user that the batch skips, never the sending device), so one refresh
   of the device lists fixes both.

Then the **mailbox caps**: a device holds at most 5 000 pending envelopes, and at most 1 000
from any single *other* user (a user's own devices are bound by the 5 000 only). Envelopes over
a cap are not stored (`ids[i] = null`, the device is listed once in `dropped_device_ids`) and the
device gets `overflow_at`, reported exactly once as `gap: true` by whichever comes first, `GET
/v1/envelopes` or the WebSocket `ready` frame (an atomic find-and-clear). Counting and inserting
hold per-device in-process locks, so the caps are exact within the single process.

**Concurrency caps** (in addition to the §5.6 rate limits, and also answered with 429
`rate_limited`, `Retry-After: 1`):

* `POST /v1/envelopes` and the avatar upload: at most 4 requests per account in flight, counted
  before any body byte is read (the app sends one batch at a time per device). A batch larger
  than 64 KiB is read whole first and then waits for one of 2 server-wide slots, held until the
  request is done: FastAPI parses a JSON body completely before the route runs, and a
  pathological 9 MiB batch such as `{"envelopes":[{},{},...]}` becomes about 250 MB of Python
  objects. Smaller batches never wait for the slots. Neither the wait nor the slot lasts
  indefinitely (`LARGE_JSON_WAIT_SECONDS`, `SLOT_SEND_TIMEOUT_SECONDS` in `middleware.py`):
  * a batch still waiting after 10 s gets the 429 (well within the app's 30 s request
    timeout), and one whose client goes away while it waits is dropped, never stored, and
    gives its account's slot back at once;
  * while a slot is held, each part of the response must be taken by the client within 5 s.
    A client that leaves it unread (e.g. one that pipelines requests on a connection it never
    reads) is abandoned: the server logs it at INFO, the rest of the response is dropped and
    the slot is freed, and Uvicorn logs `ASGI callable returned without starting response.`
    (or `...completing response.`) at ERROR.
* `GET /v1/envelopes`: at most 2 pages per device in flight (the app drains one page at a time).
  A page (up to about 5.6 MB of JSON) is sent in 64 KiB pieces, each sent only once the client
  has read enough of the previous ones, so an unread page never piles up in the server's send
  buffers. A client that reads nothing for 30 s is abandoned: the server logs it at INFO, the
  rest of the page is dropped and Uvicorn closes the connection (and logs `ASGI callable
  returned without completing response.` at ERROR).

All envelopes of a batch share one `created_at`; ids are ObjectId hex strings that strictly
increase within the process (`MonotonicObjectIds`). Envelopes are stored with the ciphertext as
BSON binary, its length as `size`, and `expires_at = created_at + FIXES_ENVELOPE_TTL_DAYS`. A TTL
index removes expired ones, and `GET` never returns an expired envelope that the TTL monitor has
not removed yet. Stored envelopes are pushed to the recipients' open sockets; if a recipient was
revoked while the batch was being stored, its envelopes are deleted again instead.

## WebSocket `/v1/ws` (§6)

1. Before accepting, the server applies the per-IP connect limit (20/min) and the cap on
   concurrent unauthenticated sockets per IP (20). Refusals are an HTTP 429 handshake response
   with the §5.1 body and `Retry-After` (the WebSocket denial-response extension, supported by
   Uvicorn).
2. The client sends `{"type":"auth","token":"<access token>"}` as its first frame, within
   `FIXES_WS_AUTH_TIMEOUT_SECONDS` (10 s). Tokens never travel in the URL, so they never reach
   access logs.
3. The server registers the socket, records `last_seen_at`, and answers
   `{"type":"ready","gap":bool}`. Of two sockets of the same device, the one opened first is
   closed with 4409, even when it finishes authenticating last (a client that gave up on a slow
   handshake keeps its newer socket). A socket closed before it sent `ready` leaves the gap
   flag for the device's next socket or `GET`. Pending envelopes are not replayed: the client
   drains them with `GET /v1/envelopes`. Registration happens before `ready`, so every envelope
   is either already in the mailbox when the client drains or pushed afterwards.
4. Server frames: `{"type":"envelope","envelope":Envelope}`, `{"type":"devices_changed"}`,
   `{"type":"pong"}`. Client frames: `{"type":"ping"}` and `{"type":"ack","ids":[..]}` (same
   rules as the REST ack). Frames are handled in order; unknown types are ignored.

| Close code | When |
|---|---|
| 4401 | bad, expired or missing token, or revoked device (also sent to a live socket when its device is revoked) |
| 4408 | no auth frame within the timeout |
| 4409 | replaced by a newer (later opened) authenticated socket of the same device |
| 1003 | binary frame |
| 1008 | the first frame is not an auth frame, a frame is not a JSON object (including JSON nested too deeply to parse), or an ack is invalid |
| 1009 | frame over 64 KiB (Uvicorn's `--ws-max-size 65536` enforces the same) |
| 1011 | unexpected server error |
| 1012 | server shutting down |
| 1013 | the client fell more than 16 MiB of queued messages behind; it reconnects and drains |

Each socket has one writer task fed by a bounded in-memory queue, so REST handlers that push
envelopes or `devices_changed` never wait on a slow client.

## Device lifecycle (§5.4)

`last_seen_at` is updated on login, refresh and WebSocket auth, and at most hourly on other
authenticated calls. The idle sweep (`services/idle_sweep.py`) runs at startup and every hour:
active devices whose `last_seen_at` is older than `FIXES_DEVICE_IDLE_DAYS` are revoked with the
full §5.4 sequence. Its first write is conditional on the device still being idle, so a device
seen again while the sweep runs keeps working. Sweep failures are logged and retried at the next
run: a revoked device no longer counts as idle, so each run first finishes revocations (of any
kind) that stopped part-way and left the device's pending envelopes behind.

## Configuration

All settings are environment variables. The server reads no configuration files; `example.env`
lists them with placeholders for use with `docker compose --env-file`. Empty values mean
"use the default".

| Variable | Default | Description |
|---|---|---|
| `FIXES_JWT_SECRET` | *(required)* | HS256 key for access tokens, at least 32 characters. The server refuses to start without it. |
| `FIXES_PUBLIC_BASE_URL` | `http://localhost:8000` | Public URL of the API, used for absolute avatar URLs (local storage). Required by the compose file. |
| `FIXES_MONGODB_URI` | `mongodb://127.0.0.1:27017` | MongoDB connection string (treated as a secret; never logged). |
| `FIXES_MONGODB_DB` | `fixes` | Database name. |
| `FIXES_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` or `ERROR`, for the server's own loggers (`fixes_server.*`). Other libraries log at `INFO` at most, and the MongoDB and S3 clients (`pymongo`, `botocore`, `boto3`, `s3transfer`, `urllib3`) at `WARNING` at most: at `DEBUG` they would log database commands (password hashes, ciphertext) and request details. |
| `FIXES_STORAGE_BACKEND` | `local` | `local` (files served at `/media`) or `s3`. |
| `FIXES_STORAGE_LOCAL_DIR` | `data/media` | Avatar directory for `local`. The Docker image sets `/data/media` (a volume). |
| `FIXES_S3_BUCKET` | — | Bucket for `s3` (required with `s3`). |
| `FIXES_S3_ENDPOINT_URL` | — | S3 API endpoint for non-AWS providers (MinIO, R2, ...). |
| `FIXES_S3_REGION` | — | S3 region. |
| `FIXES_S3_PUBLIC_BASE_URL` | — | Public-read bucket or CDN URL; avatars are `<this>/avatars/<key>.jpg` (required with `s3`). |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | — | S3 credentials, read by boto3's standard credential chain (profiles and instance roles also work). |
| `FIXES_ENVELOPE_TTL_DAYS` | `30` | Lifetime of undelivered envelopes (1-365). |
| `FIXES_DEVICE_IDLE_DAYS` | `30` | Devices unseen this long are revoked by the idle sweep. The protocol keeps it equal to the refresh-token lifetime and the envelope TTL (30). |
| `FIXES_CORS_ORIGINS` | *(empty)* | Comma-separated browser origins for CORS. The mobile app needs none. |
| `FIXES_RATE_LIMIT_REGISTER` | `5/3600` | Registrations per IP (`<count>/<seconds>`). |
| `FIXES_RATE_LIMIT_LOGIN_FAILURES_USER_IP` | `10/900` | Failed password checks per (username, IP). |
| `FIXES_RATE_LIMIT_LOGIN_FAILURES_IP` | `50/3600` | Failed password checks per IP across usernames. |
| `FIXES_RATE_LIMIT_LOGIN_SUCCESS` | `30/3600` | Successful password checks (logins, password changes, identity resets) per username. Not in the §5.6 table: correct passwords still cost an argon2 verification in the shared worker pool, and every login stores a device document. |
| `FIXES_RATE_LIMIT_REFRESH` | `30/3600` | Token refreshes per device. |
| `FIXES_RATE_LIMIT_ENVELOPES` | `600/60` | Envelope POSTs per user. |
| `FIXES_RATE_LIMIT_USER_LOOKUP` | `60/60` | User searches and id lookups per user. |
| `FIXES_RATE_LIMIT_FRIEND_REQUESTS` | `50/86400` | Friend requests created per user. |
| `FIXES_RATE_LIMIT_AVATAR` | `10/3600` | Avatar uploads per user. |
| `FIXES_RATE_LIMIT_WS_CONNECT` | `20/60` | WebSocket connects per IP. |
| `FIXES_WS_MAX_UNAUTHENTICATED_PER_IP` | `20` | Concurrent unauthenticated sockets per IP. |
| `FIXES_WS_AUTH_TIMEOUT_SECONDS` | `10` | Seconds a new socket has to send its auth frame before it is closed with 4408 (§6 says 10; at most 120). |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1,::1` (Uvicorn), `172.30.0.10` (compose) | Proxy addresses allowed to set the client IP via `X-Forwarded-For` (read by Uvicorn). List every proxy in front of the API, or all of its clients share one address for the per-IP limits. |

Compose-only variables:

| Variable | Default | Description |
|---|---|---|
| `FIXES_API_PUBLISH` | `127.0.0.1:8000` | Host `address:port` the API is published on. Use `0.0.0.0:8000` to reach it from a phone on the LAN (development only). |
| `FIXES_DOMAIN` | — | `tls` profile: domain Caddy serves and obtains a certificate for. |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | — | `s3` profile: MinIO root credentials (password at least 8 characters). |
| `FIXES_MINIO_PUBLISH` | `127.0.0.1:9000` | `s3` profile: host `address:port` of MinIO's S3 API (phones download avatars from it). |

## Run with Docker Compose

```sh
cp example.env fixes.env         # keep fixes.env out of version control
# edit fixes.env: set FIXES_JWT_SECRET, FIXES_PUBLIC_BASE_URL, ...
docker compose --env-file fixes.env up -d --build
curl http://127.0.0.1:8000/healthz
```

* **HTTPS:** set `FIXES_DOMAIN` and `FIXES_PUBLIC_BASE_URL=https://<domain>`, point the domain's
  DNS at the host, then `docker compose --env-file fixes.env --profile tls up -d`. Caddy has a fixed
  address (`172.30.0.10`) that is the only one trusted for `X-Forwarded-For`. Production must be
  HTTPS/WSS only (§3).
* **S3 avatars with MinIO:** set `FIXES_STORAGE_BACKEND=s3`, `FIXES_S3_BUCKET`,
  `FIXES_S3_ENDPOINT_URL=http://minio:9000`, `FIXES_S3_REGION=us-east-1`,
  `FIXES_S3_PUBLIC_BASE_URL=<public MinIO URL>/<bucket>`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`,
  and the same pair as `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (or better, a dedicated MinIO
  access key). Then `docker compose --env-file fixes.env --profile s3 up -d`. `minio-init`
  creates the bucket and sets a bucket policy that lets anyone read objects under `avatars/` by
  URL and nothing else: the bucket cannot be listed. The policy replaces any earlier one,
  including the listable policy that older versions of this file set. To check, listing with
  `curl -s '<public MinIO URL>/<bucket>?list-type=2&prefix=avatars'` must answer `AccessDenied`
  (403), while an avatar URL returned by the API answers 200.
* MongoDB is not published on the host, and it is on an internal network (`backend`) that only
  the API joins, so the internet-facing Caddy and MinIO containers cannot reach it. It runs
  without authentication; use credentials when `FIXES_MONGODB_URI` points at another server.
  Its data lives in the `mongo-data` volume; local avatars live in `media`.
* The API container runs as an unprivileged user with a read-only root filesystem, no Linux
  capabilities and `no-new-privileges`. Only the `media` volume and a `/tmp` tmpfs (Starlette
  spools large uploads there) are writable.
* **Client addresses behind Docker:** Docker forwards IPv6 connections to the published ports of
  an IPv4-only network through its userland proxy, so they reach Caddy (or the API) from the
  network gateway (`172.30.0.1`). So does a proxy on the host that connects to the published
  `127.0.0.1:8000`. All such clients then share one address for the per-IP limits. On a host
  with IPv6, enable IPv6 on the `fixes` network (`enable_ipv6: true` with an IPv6 subnet) so
  Docker routes IPv6 clients with their own addresses. With a host proxy instead of Caddy, set
  `FORWARDED_ALLOW_IPS=172.30.0.1` and keep `FIXES_API_PUBLISH` on loopback, so that the
  gateway address only ever carries that proxy's connections.

The compose file and Dockerfile have not been executed in the development environment of this
part (no Docker daemon was available). In particular, the MinIO image tags could not be verified
against a registry, so check that they can still be pulled.

## Run in a virtual environment

Requires Python 3.12+ (developed on 3.13) and a MongoDB 7+ server.

```sh
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # Windows; use .venv/bin/python elsewhere
export FIXES_JWT_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
export FIXES_MONGODB_URI=mongodb://127.0.0.1:27017
.venv/Scripts/python -m uvicorn --factory fixes_server.main:app_from_env \
    --host 127.0.0.1 --port 8000 --proxy-headers --ws-max-size 65536
```

Interactive API docs are at `/docs`; the OpenAPI schema is at `/openapi.json`.

## Tests and checks

The tests need a real MongoDB server, at `mongodb://127.0.0.1:27099` by default (override with
`FIXES_TEST_MONGODB_URI`). Each test creates a uniquely named `fixes_test_<hex>` database and
drops it afterwards. If the server is unreachable, the tests fail with a clear message rather
than being skipped.

```sh
.venv/Scripts/python -m pytest -q
.venv/Scripts/python -m ruff check .
.venv/Scripts/python -m ruff format --check .
.venv/Scripts/python -m mypy src
```

### End-to-end tests with the app

`scripts/e2e_server.py` runs a throwaway server for the app's end-to-end suite
(`../fixes-app/e2e`, see its README): a new `fixes_e2e_<hex>` database, a JWT secret generated
at runtime and never printed, avatars in a new temporary directory, raised rate limits, Uvicorn
on `127.0.0.1:8099`. It runs the given command with `FIXES_E2E_API_URL` set (or serves until a
`--stop-file` appears), then stops the server gracefully, fails if any envelope is left in the
database, drops the database and deletes the avatar directory.

```sh
.venv/Scripts/python scripts/e2e_server.py --mongodb-uri mongodb://127.0.0.1:27017 \
    --cwd ../fixes-app -- npm run test:e2e
```

`tests/helpers.py` has reusable helpers: users, logged-in devices with real X25519 keys,
identities and certificates with real Ed25519 keys, friendships, test images, a
`RecordingHooks` that records revocation and `devices_changed` events, `ClientIpOverride`,
which simulates distinct client IPs, `pause_first_password_check`, which holds a request right
after its argon2 check so tests can race another request against it, `scan_heavy_jpeg` (a valid
progressive JPEG with many cheap scans), envelope helpers (`outgoing`, `send`, `fetch`,
`fill_mailbox` to reach the caps quickly) and WebSocket helpers (`live_socket` for an
authenticated session, `ws_receive`/`ws_expect_close` with a timeout so a missing frame fails
the test instead of hanging it, and `LiveSocket.sync()`, a ping/pong barrier). The WebSocket
auth timeout is shortened per test with `make_client(ws_auth_timeout_seconds=0.2)`.

## Security notes

* Passwords: argon2id (`t=3, m=64 MiB, p=1`), rehashed on login when the parameters change. Unknown
  usernames run a dummy verification so timing matches. Login failures, and successful password
  checks per account, are rate-limited before any hashing; password changes and identity resets
  count as login attempts. A password check takes a while, so logins, password changes and
  identity resets re-check afterwards that the password was not changed (and the device not
  revoked) in the meantime: a password change reliably signs out every other device.
* Tokens: 15-minute HS256 access tokens (`sub`, `did`, `typ`). Refresh tokens are 32 random bytes,
  stored only as SHA-256, single use with a 60 s retry grace and a sliding 30-day expiry. Reusing a
  spent token revokes the device.
* Every authenticated request checks the device's `revoked_at`. Device documents are never deleted.
* Device keys must be 32-byte X25519 keys that are not low-order points. Certificates are Ed25519
  signatures verified against the account identity key before they are stored.
* Avatars are re-encoded: header dimensions are checked before decoding, decompression bombs are
  errors, JPEGs with more than 64 scans are refused before decoding (each progressive scan is a
  full pass over the image, and libjpeg sets no limit), and only the first frame is kept. Output
  is a ≤512 px JPEG without EXIF or ICC data, stored under a random key.
* Request bodies are limited by `Content-Length` and by counting streamed bytes (64 KiB in general,
  5.5 MiB for avatars, 9 MiB for envelopes). The two larger limits apply only to requests whose
  bearer access token verifies; others get 401 `unauthorized` before any body byte is read.
  Each account may have only 4 such requests in flight, and envelope batches over 64 KiB are
  parsed at most 2 at a time server-wide (see the concurrency caps under Envelopes).
* Errors never echo input values or internals. A 422 names at most 20 fields in
  `details.fields` (names cut to 64 characters, each distinct message once) and counts any
  others in `details.omitted_fields`, so it stays a few KB whatever the body, even one full
  of unknown keys. The server never logs request bodies or tokens. Configuration errors never
  print values.
* Client IPs come from the socket peer, or from `X-Forwarded-For` only when the peer is listed in
  `FORWARDED_ALLOW_IPS`. Per-IP limits count an IPv6 client by its /64 (what one subscriber is
  routed), so rotating addresses inside it does not reset them; IPv4-mapped addresses count as
  IPv4.
* Envelope senders always come from the access token; request bodies cannot name one. Messaging
  another user needs a friendship and a linked (certified) sending device, and only linked
  recipient devices of other users are accepted.
* WebSocket tokens travel in the first frame, never in the URL. Unauthenticated sockets are
  limited per IP and closed after the auth timeout.
* What the server can see and keep is listed in §15 and below. Tell users and operators.

## Operations notes (§15)

What this server can see and keep:

* **Never:** message bodies, receipts' contents, history, backups, device or identity secret
  keys, the link-transfer secret, the recovery key.
* **Transiently:** ciphertext envelopes with sender and recipient user and device ids,
  timestamps and sizes (padded by the app to 256-byte buckets), until the recipient device acks
  them or for at most `FIXES_ENVELOPE_TTL_DAYS` (30) days. Envelopes of revoked devices are
  deleted with the revocation.
* **Persistently:** accounts (username, password hash, avatar, identity public key), devices
  (name, public key, certificate, last seen, revocation time; never deleted), friendships and
  pending friend requests.
* **Metadata:** who talks to whom and when, approximate message sizes, receipt timing, device
  counts, last-seen times, and client IP addresses in access logs.

What operators should do:

* **Keep deleted ciphertext short-lived.** Acked and expired envelopes are deleted, but deleted
  documents survive in MongoDB's oplog (replica sets) and in host or Atlas snapshots for their
  retention period. There is no forward secrecy, so a later theft of a device secret key could
  decrypt such copies. Keep oplog windows small and exclude this database from long-lived
  snapshots where possible. A standalone MongoDB (as in the compose file) has no oplog.
* **Never log request bodies or tokens.** The server does not, even with `FIXES_LOG_LEVEL=DEBUG`
  (the database and S3 client loggers stay at `WARNING`); do not add body-logging middleware or
  proxy logging that captures bodies or `Authorization` headers. Uvicorn's access
  log records client IPs, methods and paths (including query strings such as user searches);
  lower `--log-level` or rotate those logs according to your privacy policy.
* **Run exactly one API process** (one container, one Uvicorn worker). Sockets, fan-out, rate
  limits and the mailbox locks are in memory. A restart closes every socket with 1012; clients
  reconnect and drain their mailboxes, so nothing is lost.
* **Proxies must pass WebSocket upgrades** for `/v1/ws` and keep idle connections open for at
  least the 25 s client ping interval. The bundled Caddy configuration does both. Uvicorn
  also sends WebSocket-level pings (every 20 s by default) and drops dead peers.
* **Size the database for the mailbox caps:** at most 5 000 pending envelopes of up to 64 KiB
  per device, so a worst-case mailbox is about 320 MiB. Normal mailboxes stay near empty because
  devices drain and ack continuously.
* **Revocation of idle devices** happens at startup and hourly. After restoring an old database
  backup, expect devices that have been idle longer than `FIXES_DEVICE_IDLE_DAYS` to be revoked
  at the first start.

## Limitations

* **Single instance only:** rate limits, sockets and mailbox locks are in memory and reset on
  restart. Running several replicas would multiply limits, break fan-out and make the mailbox
  caps approximate.
* Pushes are best effort. If a client falls too far behind, its socket is closed (1013) and it
  catches up from the mailbox after reconnecting.
* `gap` is reported once; if that response is lost in transit, the client does not see it again.
* If MongoDB fails part-way through storing a batch, a prefix of it may be stored while the
  sender sees a 500; its retry then stores duplicates, which clients ignore by message id.
* Envelope batches are parsed before the per-user envelope limit is checked. Parsing the worst
  9 MiB batch measured (`{"envelopes":[{},{},...]}`; batches full of unknown keys are cheaper,
  as they are refused before validation) costs about 250 MB and blocks the event loop for about
  0.3 s. With 2 such batches handled at a time, an attacker sending them back to back slows
  every request (one account with 4 in flight for 30 s: `/healthz` median 0.25 s, at most
  0.6 s, server peak about 580 MB), but the parsed objects stay bounded. Request bodies still
  uploading are held as they are (in memory, or avatars in `/tmp`), up to 4 per account, so
  many accounts uploading at once add up linearly. A response its client leaves unread keeps
  its server-wide slot for at most 10 s (5 s for each of its two parts), so attackers with
  many connections that stall in turn can keep other users' large batches waiting, up to the
  10 s after which those get 429 and are retried.
* Each device may hold 2 envelope pages (up to about 5.6 MB each) in memory while its clients
  read them, so an account that fills the mailboxes of its 10 devices and reads slowly can tie
  up about 110 MB.
* Without transactions, two simultaneous logins can both pass the 10-device cap check.
* Avatar replacement deletes the old object after switching. A crash in between can leave an
  orphaned file (never a broken avatar).
* No push notifications, forward secrecy, group chats or legacy-account migration (§1).
