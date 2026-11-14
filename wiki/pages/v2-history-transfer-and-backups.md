---
title: v2 history transfer and backups
type: decision
summary: "v2 ways to move device-only history (protocol rev 2): QR device linking that sends the identity key and history under an extra QR-secret layer, and recovery-key-encrypted backup files never uploaded to the server."
tags: [v2, e2ee, backup, linking, decision]
sources: []
updated: 2026-11-13
---

# v2 history transfer and backups

**Status: per [`docs/protocol.md`](../../docs/protocol.md) rev 2.1, §4.3, §7.3, §9, §10; implemented as of
2026-11-13** in `fixes-app/src/core/linking`, `src/core/snapshot` and `src/core/backup` ([fixes-app](fixes-app.md)).

## Context

The server never stores conversations ([v2 architecture](v2-architecture.md)) and a new device only receives messages
sent after it is linked. Without these mechanisms, history is lost with the device. OS backups are deliberately not a
recovery path ([Expo OS backups gotcha](expo-os-backups-leak-app-data.md)).

## Device linking with history transfer

1. A new device B that is not the first device and lacks the AIK shows the QR
   `fixes-link:1:<transfer_id>:<B device id>:<B public key>:<transfer_key>`. The 32-byte transfer key travels only in
   the QR.
2. Linked device A scans it, requires `GET /v1/devices` to list B **with exactly the QR's public key** (defeats server
   key substitution), certifies B ([account identity key](v2-account-identity-key.md)), sends one `link` envelope (the
   AIK key pair), then `history` chunks (inner JSON ≤ 48 000 bytes) from one read-transaction snapshot.
3. `link`/`history` payloads add an inner XChaCha20-Poly1305 box keyed by the transfer key, with AAD binding kind,
   transfer id, attempt id, seq and total. The key is deleted on completion, so transfer copies left in server
   oplogs/snapshots stay unreadable even if B's device key leaks later.
4. Each attempt has an `attempt_id`. B binds to the first (sender device, attempt); a new attempt from the same device
   resets progress (imported rows stay); other devices' chunks are ignored. Expiry: 30 min to the first chunk, then
   10 min of inactivity. A offers **Resend**. Linking without history still sends `link` + one empty `history` chunk.
5. App addition (not in the spec): an already linked device can show a link code under **Receive history** to refill
   its history after a mailbox gap; leaving the screen before anything arrived cancels the transfer, so its secret
   stops being valid. Every attempt, including a resend, sends `link` again under its `attempt_id`.

## Backups

- A `.fixes` JSON file; the body (conversations, messages, contact identities) is XChaCha20-Poly1305-encrypted with a
  key = HKDF-SHA256 over an app-generated **recovery key**: 120 random bits as 24 Crockford base32 characters (6
  groups of 4), kept in secure storage, viewable in Settings, confirmed by re-typing the last group before the first
  export. AAD binds user id, creation time and salt.
- Exported through the share sheet, **never uploaded to the Fixes server**. Import refuses another user's backup; a
  wrong key changes nothing.
- *Rejected (rev 1)*: user passphrase + scrypt. Passphrases stored on third-party clouds are brute-forceable offline,
  and scrypt was slow on Hermes.

## Merge rules (both paths)

`INSERT OR IGNORE`, keeping the highest status; imported `pending` rows become `failed`; incoming rows from a backup
become `read`; an existing contact pin wins and a conflicting key is reported, never imported; inconsistent rows are
skipped and counted; `receipt_hints` are applied afterwards.

## Consequences

The user is responsible for backups. Losing every device without a backup loses the history; resetting the identity
recovers the account, not the messages.

Related: [v2 account identity key](v2-account-identity-key.md), [Run the e2e suite](run-e2e-suite.md) (covers
multi-chunk linking and backup import).
