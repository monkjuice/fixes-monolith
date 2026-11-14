---
title: Run the server tests
type: guide
summary: "fixes-server checks: pytest (331 tests as of 2026-11-13) against any reachable mongod via FIXES_TEST_MONGODB_URI (default port 27099), plus ruff and mypy; tests fail rather than skip without MongoDB."
tags: [v2, server, guide, testing, mongodb]
sources: []
updated: 2026-11-13
---

# Run the server tests

From `fixes-server/`, with the virtual environment from [Run the server locally](run-server-locally.md):

```sh
export FIXES_TEST_MONGODB_URI=mongodb://127.0.0.1:27017   # default: mongodb://127.0.0.1:27099
.venv/Scripts/python -m pytest -q
.venv/Scripts/python -m ruff check .
.venv/Scripts/python -m ruff format --check .
.venv/Scripts/python -m mypy src
```

- The tests need a **real MongoDB**; any reachable `mongod` works (standalone is enough, the server uses no
  transactions). Each test creates and drops its own `fixes_test_<hex>` database. An unreachable server fails the run
  with a clear message; nothing is skipped.
- 331 tests as of 2026-11-13 (all pass; ruff and mypy clean).
- Reusable helpers live in `tests/helpers.py`: real X25519/Ed25519 keys and certificates, `RecordingHooks`,
  `ClientIpOverride` (distinct client IPs), `pause_first_password_check` (race a request against another right after
  its argon2 check), `scan_heavy_jpeg`, `fill_mailbox`, and WebSocket helpers with timeouts (`live_socket`,
  `ws_receive`, `ws_expect_close`, `LiveSocket.sync()`). Shorten the WebSocket auth timeout per test with
  `make_client(ws_auth_timeout_seconds=0.2)`.
- These tests cannot catch drift from the app's reading of the protocol: also run the
  [e2e suite](run-e2e-suite.md) ([why](contract-drift-needs-e2e.md)).

Related: [fixes-server](fixes-server.md).
