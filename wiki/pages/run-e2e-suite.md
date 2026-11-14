---
title: Run the e2e suite
type: guide
summary: "Run fixes-app/e2e (the real app core against a real fixes-server, 18 ordered tests) via fixes-server/scripts/e2e_server.py, which uses a throwaway database and fails the run if envelopes are left behind."
tags: [v2, app, server, guide, testing, e2e]
sources: []
updated: 2026-11-13
---

# Run the e2e suite

`fixes-app/e2e/messaging.test.ts` drives the real app core (`SessionManager`, `MessagingEngine`, linking, backups, with
the Node adapters) against a real `fixes-server` over HTTP and WebSocket. As of 2026-11-13 it is one scenario of 18
ordered tests that share state: friends, typed errors, live and offline delivery, receipts, linking with multi-chunk
history, fan-out, revocation, non-friend refusal, token rotation and 4409, backups, avatars, mailbox caps, identity
reset, logout. The mailbox-cap flood step expects one "1000 messages from <bob> could not be decrypted" notice
([Collapsed undecryptable notices](undecryptable-notices.md)). Last run 2026-11-13: 18/18 against the real server, 0
envelopes left. No screens, no device or emulator, and Node adapters instead of Expo's (so it cannot catch
[expo/fetch pitfalls](expo-fetch-pitfalls.md)). `e2e/README.md` lists the scenario as 18 numbered steps, one per test;
keep the two in step.

## With the launcher (the supported way)

From `fixes-server/`, with its virtual environment and any reachable MongoDB:

```sh
.venv/Scripts/python scripts/e2e_server.py --mongodb-uri <uri> --cwd ../fixes-app -- npm run test:e2e
```

The launcher creates a `fixes_e2e_<hex>` database, a JWT secret generated at runtime (never printed), a temporary
avatar directory and raised rate limits; serves on `127.0.0.1:8099`; runs the command with `FIXES_E2E_API_URL` set;
then stops the server, **fails the run if any envelope is left** in the database (every device must drain), drops the
database and deletes the avatars. With `--stop-file <path>` instead of a command it serves until that file exists, so
you can rerun `FIXES_E2E_API_URL=http://127.0.0.1:8099 npm run test:e2e` from `fixes-app/`. It is the only launcher; an
earlier shell script in `fixes-app/e2e/` was removed.

## Against another server

`FIXES_E2E_API_URL=<base URL without /v1> npm run test:e2e`. One run makes 5 registrations and ~13 WebSocket connects
within seconds, so the protocol's default limits break repeated runs: raise `FIXES_RATE_LIMIT_REGISTER`,
`FIXES_RATE_LIMIT_WS_CONNECT` and `FIXES_WS_MAX_UNAUTHENTICATED_PER_IP` there.

## Writing tests

Use `e2e/support/harness.ts` (`createMessagingPhone()`, with traffic capture that never records tokens), generate
users with `uniqueUsername()` / `randomPassword()`, clean up phones in `afterAll`, and leave every device drained.

Why this suite matters: [Unit tests miss contract drift](contract-drift-needs-e2e.md).

Related: [fixes-app](fixes-app.md), [fixes-server](fixes-server.md), [Run the server tests](run-server-tests.md).
