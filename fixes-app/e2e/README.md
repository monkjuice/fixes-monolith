# End-to-end tests

The suite in this folder drives the **real** app core (`src/core`: API client, `SessionManager`,
messaging engine, linking, backups) against a **real** `fixes-server` over HTTP and WebSocket, with the
Node adapters from `src/test-utils` (better-sqlite3 database files in a temp directory, in-memory secure
storage, `ws` WebSocket, `fetch` uploads). It is not part of `npx jest` / `npm test`.

## Running it

The easiest way is the server's launcher, which starts a throwaway server, runs the suite against it and
cleans up:

```sh
# from fixes-server/, with its virtual environment and a reachable MongoDB
.venv/Scripts/python scripts/e2e_server.py --mongodb-uri mongodb://127.0.0.1:27017 \
    --cwd ../fixes-app -- npm run test:e2e        # .venv/bin/python on Linux/macOS
```

`scripts/e2e_server.py` creates a new database `fixes_e2e_<random hex>`, generates a JWT secret at
runtime (never printed), stores avatars in a new temporary directory, raises the rate limits so a run
cannot hit them, starts Uvicorn on `127.0.0.1:8099` and waits for `/healthz`. It runs the command with
`FIXES_E2E_API_URL` set, then stops the server gracefully, **fails the run if any envelope is left in
the `envelopes` collection** (every device must have drained its mailbox), drops the database and
deletes the avatar directory. Without a command it serves until the file named by `--stop-file`
exists, which is handy while writing tests:

```sh
.venv/Scripts/python scripts/e2e_server.py --mongodb-uri mongodb://127.0.0.1:27017 --stop-file /tmp/e2e.stop &
FIXES_E2E_API_URL=http://127.0.0.1:8099 npm run test:e2e     # from fixes-app/, as often as needed
touch /tmp/e2e.stop                                           # tear down: envelope check, drop database
```

Against any other running server:

```sh
FIXES_E2E_API_URL=http://127.0.0.1:8000 npm run test:e2e
```

| Variable | Example | Meaning |
|---|---|---|
| `FIXES_E2E_API_URL` | `http://127.0.0.1:8099` | Base URL of the server under test (no `/v1`). `http` is accepted because e2e uses development rules. Without it the suite fails at once with an explanation; an unreachable server fails the `/healthz` check in `beforeAll`. |

The server's rate limits apply (§5.6). One run makes 5 registration attempts (3 succeed), 18 login
attempts (16 devices) and about 13 WebSocket connections within ten seconds, so the protocol defaults (5
registrations per hour per IP, 20 WebSocket connects per minute per IP) are too low for repeated runs: use the launcher, or raise `FIXES_RATE_LIMIT_REGISTER`,
`FIXES_RATE_LIMIT_WS_CONNECT` and `FIXES_WS_MAX_UNAUTHENTICATED_PER_IP` on your test server.

## What `messaging.test.ts` covers

One scenario whose steps run in order and share state. Alice has devices A1–A3, bob B1–B3 and carol C1:

1. Register alice and bob; their first devices create the identity key (§9 step 1) and certify themselves.
2. User search, friend request and accept.
3. §5.1 errors as typed client errors: `username_taken` (case-insensitive), `validation_error` with
   `details.fields`, `invalid_credentials`, `already_friends`, `cannot_friend_self`, `not_found`,
   `invalid_image`.
4. A1 → B1 arrives **live** (a pushed `envelope` frame, no mailbox drain), decrypts, and its
   `server_ts` matches the POST response; delivered and read receipts reach A1; bob replies; read sync.
5. Offline catch-up: B1's engine is stopped while A1 sends five messages; on restart it drains
   `GET /v1/envelopes` in pages of two (2, 2, 1, 0) and acks; no pushes involved.
6. A2 logs in (`needsLink`), shows its QR string, A1 consumes it, certifies A2 and sends `link` plus a
   **multi-chunk** history (bodies of 4 000 `€` / emoji code points, chunks measured in UTF-8 bytes); A2
   ends up with the AIK and the same history; the transfer key is deleted.
7. A1 sends again: B1 gets the message, A2 the sync copy, both get the delivered receipt.
8. B2 is linked from B1 with history.
9. Messages from A1, A2 and B2 fan out to all four devices (`stale_devices` 409s are answered by
   refreshing the device lists, §8).
10. B1 revokes B2 after a REST refresh made B2's socket token older than the one in memory: B2 is signed
    out (socket 4401, refresh refused), B2's last message is still accepted
    by A2 via `GET /v1/users/{id}/devices/{device_id}` because it was created before `revoked_at`, and no
    later envelope from A1 or B1 is encrypted to B2.
11. Carol (not a friend) gets 403 `not_friends` for device lists, the single-device lookup and
    `POST /v1/envelopes`; her engine marks the message `failed`; a pending request is not a friendship
    (`request_exists`, then declined); the 11th device gets 409 `too_many_devices` with the list.
12. Token rotation (`POST /v1/auth/refresh`), a forged access token → 401 `unauthorized` → one refresh
    and a retry (REST) / 4401 → refresh → reconnect (socket); a second socket of A1 replaces the engine's
    (4409), the server answers fast pings, and the engine resumes on `onForeground()` and drains.
13. Backup export on A1 (recovery key, confirmation), import on A2 (nothing added) and on A3, a reinstall
    that kept the identity key but not the database (wrong key refused and nothing changed; then
    everything restored, incoming rows `read`, idempotent re-import); A3 then receives live.
14. Avatar upload of a generated PNG (re-encoded by the server to JPEG, served from `/media`), seen by
    bob through `GET /v1/users/{id}` and `refreshPeers`.
15. Mailbox caps: bob floods A3 (offline) with 1 001 undecryptable envelopes; the server keeps 1 000
    (`ids: [null]`, `dropped_device_ids`), A3 reports the gap once, acks everything and shows a single
    "1000 messages from bob could not be decrypted" system message (§13: consecutive failures collapse
    into one counting notice), with bob's unread count and last activity unchanged.
16. Bob resets his identity on B3 (B1 signed out): alice's next message fails, her pin becomes
    pending with a "safety code changed" system message, B3's message is still shown on every alice
    device, sending is refused until alice accepts, then the failed message is retried and delivered.
17. Every remaining device has an empty outbox and mailbox; no engine logged an error.
18. A3 logs out (§13): drain, flush, `POST /v1/auth/logout`, session forgotten, device gone from the list.

## Writing more tests

- Files are named `*.test.ts` (matched by `jest.e2e.config.js`: Node environment, one worker, 60 s per
  test).
- Use `support/harness.ts`: `createMessagingPhone({deviceName, timings, config})` gives a phone with a
  `SessionManager`, an attached `MessagingEngine` (short retry delays, `E2E_TIMINGS`), a `BackupService`
  on a `MemoryFileAdapter`, a `CapturingLogger` and `traffic`: per request method, path and status,
  the recipients of envelope POSTs, the envelope ids of mailbox GETs, and the type of every socket
  frame. Headers (tokens) and other bodies are never recorded. `createPhone()` is the same without the
  engine. `support/png.ts` generates PNG files.
- Create users with `uniqueUsername()` / `randomPassword()`; never hard-code or print credentials.
- Always clean up phones (`phone.cleanup()`) in `afterAll`/`afterEach`.
- Leave every device drained at the end: the launcher fails a run that leaves envelopes behind.
