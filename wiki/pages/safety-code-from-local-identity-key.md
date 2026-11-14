---
title: Safety codes use the device's own identity key
type: gotcha
summary: "Compute your side of a safety code (and the 'Linked' check) from the AIK held on this phone, never the server's copy of your own key; otherwise a malicious server can make both users' codes match while it reads their messages."
tags: [v2, e2ee, identity, security, gotcha]
sources: []
updated: 2026-11-13
---

# Safety codes use the device's own identity key

A critical finding of the `fixes-app/` code review (2026-11), now fixed. Protocol §4.4 defines the code over both AIKs
but does not say where your own comes from.

## Pitfall

If the app takes its **own** AIK from the server (`GET /v1/users/me`), a man-in-the-middle server can give alice fake
keys `S_A` (as hers) and `S_B` (as bob's), and give bob the same pair the other way round. Both phones then compute the
code over `S_A, S_B`: the codes match and "Mark as verified" succeeds while the server decrypts and re-encrypts every
message. Using the key the phone itself holds makes the codes differ.

## Rule (as of 2026-11-13)

- Safety codes (`src/core/crypto/safetyCode.ts`, Security screen) and "Linked" on the Devices screen use the AIK in this
  phone's secure storage.
- A phone whose stored AIK differs from the server's account key (identity reset on another device, or substitution) is
  not treated as linked on the server's word: it shows "Link this device" until a link transfer brings the account key,
  and Security shows a warning instead of a code.
- An account with no key on the server gets back the AIK this phone holds, not a new one.

General lesson: never let the server supply both sides of a value that is meant to detect the server.

Related: [v2 account identity key](v2-account-identity-key.md), [fixes-app](fixes-app.md).
