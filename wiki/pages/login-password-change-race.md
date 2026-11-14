---
title: Login racing a password change
type: gotcha
summary: "A login whose slow argon2 check verified the old password could create a device that survived a concurrent password change; login re-checks the stored hash after creating the device and revokes it if the password changed."
tags: [v2, server, auth, concurrency, security, gotcha]
sources: []
updated: 2026-11-13
---

# Login racing a password change

Found in the `fixes-server/` code review (2026-11), now fixed.

## Pitfall

argon2 verification takes a while in a worker thread. A login that verified the **old** password could create its
device after `POST /v1/auth/password` had already revoked "all other devices", so the old password still produced a
working device. With no MongoDB transactions there is no isolation to rely on.

## Fix (as of 2026-11-13)

- Login (`routers/auth.py`) creates the device, then calls `password_unchanged()` (`services/accounts.py`), which
  re-reads the stored hash; if it changed, the new device is revoked and the answer is 401 `invalid_credentials`.
- The password change writes the new hash and revokes the other devices in an order (per the README: before and again
  after the hash write) that guarantees either it sees the new device or the login sees the new hash.
- Password changes and identity resets re-check the same way, including that the calling device was not revoked
  meanwhile.
- Tests race requests with `pause_first_password_check` (`tests/helpers.py`).

General rule: when a slow check runs outside a lock and without transactions, re-validate after the write that depends
on it, and order the writes so that at least one side always sees the other.

Related: [fixes-server](fixes-server.md), [v2 delivery reliability](v2-delivery-reliability.md).
