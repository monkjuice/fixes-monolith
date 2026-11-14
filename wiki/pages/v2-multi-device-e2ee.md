---
title: v2 multi-device E2EE
type: decision
summary: "v2 message crypto (protocol rev 2): per-device X25519 keys, padded XChaCha20-Poly1305 envelopes fanned out to every certified device of both users, encrypted receipts, no forward secrecy."
tags: [v2, e2ee, crypto, decision]
sources: []
updated: 2026-11-13
---

# v2 multi-device E2EE

**Status: per [`docs/protocol.md`](../../docs/protocol.md) rev 2.2, §4.2, §7, §8, §13; implemented as of 2026-11-13** in
`fixes-app/src/core/crypto`, `src/core/payloads` and `src/core/trust` ([fixes-app](fixes-app.md)); the server only
validates public keys and certificates.

## Context

The [Legacy app](legacy-app.md) used ephemeral RSA-1024 keys exchanged live over SignalR: both users had to be online,
messages were capped at ~58 characters and only one device per user worked ([Legacy defects](legacy-defects.md)).

## Choice

- **Device key**: every login creates a device with a fresh X25519 key pair; the secret never leaves the device. A
  device takes part only once certified by the [account identity key](v2-account-identity-key.md).
- **Envelope**: key = HKDF-SHA256 over the X25519 static-static secret with `info = "fixes/v1/envelope" || s_pk ||
  r_pk` (sender key first on **both** sides); XChaCha20-Poly1305, random 24-byte nonce; AAD binds sender user, sender
  device and recipient device. Plaintext JSON is space-padded to a multiple of 256 bytes to blur sizes (an already
  aligned plaintext gets no extra block; over 65 280 padded bytes is refused before sending). Client libraries:
  `@noble/curves`, `@noble/ciphers`, `@noble/hashes`. Because the HKDF info is ordered, the two directions derive
  different keys: the app's derived-key cache is keyed per direction.
- **Fan-out**: one envelope per linked device of the recipient and per *other* linked device of the sender (sync
  copies). `delivered`/`read` receipts are encrypted payloads too; `read` also goes to the reader's other devices to
  sync unread state. Completeness checks, ordering and retries: [v2 delivery reliability](v2-delivery-reliability.md).
- **Eligibility**: only devices whose certificate verifies under the pinned AIK are encrypted to; envelopes from
  anything else are dropped. Device lists are cached 60 s per user.
- **Revoked senders**: device documents are never deleted, so `GET /v1/users/{u}/devices/{d}` still returns a revoked
  device's key; its envelopes are accepted if created before `revoked_at`.

## Rejected / limitations

- **No forward secrecy**: a leaked device secret decrypts every envelope ever sent to that device, including copies
  surviving in MongoDB oplogs or snapshots ([server visibility](v2-server-visibility.md)). Double ratchet is a
  follow-up. No sealed sender: the server sees who talks to whom.

## Gotchas

- The server takes sender ids from the access token, never the body; receivers still check
  `payload.from == envelope.sender_user_id` and validate every payload field.
- An undecryptable envelope is acked and dropped; for a known contact the app shows the system message "A message
  from <username> could not be decrypted". **Rev 2.2 §13 rule**: consecutive failures from the same contact collapse
  into that one notice, which counts them ("<n> messages from <username> could not be decrypted"); a new notice starts
  only after a message from that contact was stored successfully. System messages never change `unread_count` or
  `last_activity_at`. Why: a hostile friend could otherwise add up to 1 000 notices (the per-sender mailbox cap) per
  mailbox fill. Implemented and verified in the app as of 2026-11-13, with no schema change:
  [Collapsed undecryptable notices](undecryptable-notices.md).
- `import 'react-native-get-random-values'` must be the **first** import of the app entry, before any `@noble`
  module; all randomness comes from `crypto.getRandomValues`, never `Math.random` (self-tested at startup).

Related: [v2 architecture](v2-architecture.md), [v2 history transfer and backups](v2-history-transfer-and-backups.md).
