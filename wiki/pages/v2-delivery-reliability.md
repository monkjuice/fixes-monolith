---
title: v2 delivery reliability
type: decision
summary: "v2 sessions and delivery rules (protocol rev 2.2, implemented): atomic refresh rotation with 60 s retry grace, signed-out signals, 30-day idle device revocation, capped mailboxes with a gap flag, completeness check, server-time ordering, local outbox, receipt coalescing and hints, socket replacement and close codes."
tags: [v2, reliability, auth, sync, decision]
sources: []
updated: 2026-11-13
---

# v2 delivery reliability

**Status: per [`docs/protocol.md`](../../docs/protocol.md) rev 2.2, §5.3–5.5, §6, §7.2, §13; implemented as of
2026-11-13** (server: `services/sessions.py`, `services/revocation.py`, `services/envelopes.py`, `realtime/`; app:
`src/core/messaging`, `src/core/api`). Each rule fixes a failure mode the design review found in rev 1.

## Sessions and devices

- **Refresh tokens**: 15-min access JWT (`sub`, `did`); 30-day sliding refresh tokens stored as SHA-256, rotated
  atomically with one `find_one_and_update` on `used_at: null`. Reusing a token spent < 60 s ago whose successor is
  still unused counts as a client retry and gets a fresh pair; any other reuse revokes the device. *Rejected*: strict
  reuse detection, which revoked devices on ordinary network retries.
- **Signed-out signals** (rev 2.1): a completed revocation deletes the refresh tokens, so a later refresh gets 401
  `invalid_refresh_token`; `device_revoked` only reaches authenticated calls made with a still-valid access token (or a
  refresh after an interrupted revocation). Clients must treat both as "signed out".
- **Login vs password change**: login re-checks the password hash after creating its device
  ([gotcha](login-password-change-race.md)).
- **Idle revocation**: an hourly sweep revokes devices unseen for `FIXES_DEVICE_IDLE_DAYS` (30 = refresh lifetime =
  envelope TTL). Dead devices would otherwise fill mailboxes and block every send to that user.
- **Revocation order** (idempotent): `revoked_at` → refresh tokens → pending envelopes → close WebSocket 4401 →
  `devices_changed`. Logout, device delete, password change (all others), identity reset, token reuse and the idle
  sweep all use it. Max 10 active devices.

## Mailboxes and sending

- **Caps**: ≤ 5 000 pending envelopes per device and ≤ 1 000 from any single other user. Overflowing envelopes are not
  stored (`ids[i] = null`, `dropped_device_ids`), the device gets `overflow_at`, reported once as `gap: true`; the app
  tells the user to re-link from another device. *Rejected*: all-or-nothing batch failure.
- **Completeness**: messages are posted with `complete_for_user_ids: [to, from]`; if a linked device of those users is
  not targeted, 409 `stale_devices` returns `missing_device_ids`, the app refreshes device lists and retries once. New
  devices are thus never skipped silently.
- **Ordering** uses the server timestamp (`envelope.created_at` → `server_ts`/`sort_ts`); `sent_at` (sender clock) is
  display only.
- **Outbox**: the message row and an `outbox` row are written in one SQLite transaction; a worker retries with backoff
  (1 s → 5 min). Status only moves forward. Imported `pending` rows become `failed` and are never auto-sent.

## Receipts and receiving

- Receipts are coalesced per (peer, status) with ~1 s debounce and sent via the outbox. Receipts for unknown message
  ids go to `receipt_hints` and are applied when the row appears (pruned after 30 days).
- `delivered` only for rows this device actually inserted; `read` only for rows viewed on this device (never via sync
  or import).
- Permanent failures (decrypt/validation, ineligible sender device, unknown kind) are acked and dropped. Since rev 2.2,
  undecryptable messages from one contact collapse into a single counting notice and system messages never touch
  `unread_count` or `last_activity_at` ([rule](v2-multi-device-e2ee.md), [app implementation](undecryptable-notices.md)).
- **Gotcha**: the WebSocket `ready` does not replay pending envelopes. The client buffers pushes, drains
  `GET /v1/envelopes` page by page (apply page in one transaction, then ack), then processes the buffer, skipping ids
  already applied. Transient errors stop the queue without acking. A page also ends at about 4 MiB of ciphertext
  (rev 2.1), so a short page does not mean the mailbox is empty: drain until an **empty** page.
- The server registers the socket before sending `ready`, so every envelope is either already in the mailbox when the
  client drains or pushed afterwards.

## Sockets (rev 2.1)

- One socket per device, decided by **connection order**: the older socket is closed with 4409 even if it finishes
  authenticating last, so an abandoned slow handshake never replaces a newer socket. After 4409 the app stays down
  until it returns to the foreground.
- Close codes 1003 (binary frame), 1008 (bad or out-of-order frame), 1009 (> 64 KiB), 1011 (server error), 1012
  (shutdown/restart), 1013 (client > 16 MiB behind on queued pushes): reconnect with backoff 1 s → 30 s and drain.
- The auth frame must arrive within `FIXES_WS_AUTH_TIMEOUT_SECONDS` (default 10) or the socket closes with 4408.
- On 4401 the app always makes a real refresh round trip (`src/core/realtime/socket.ts`), never reusing an access
  token a REST call just rotated, so a revoked device gets `device_revoked`/`invalid_refresh_token` and signs out
  promptly; a second 4401 in a row backs off without refreshing again (as of 2026-11-13, after code-review round 2).

Related: [v2 multi-device E2EE](v2-multi-device-e2ee.md), [v2 account identity key](v2-account-identity-key.md),
[v2 architecture](v2-architecture.md), [fixes-server](fixes-server.md), [fixes-app](fixes-app.md).
