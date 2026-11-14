---
title: What the v2 server sees and keeps
type: concept
summary: "Per protocol rev 2 §15: what the v2 server never sees, keeps transiently (ciphertext up to 30 days, plus oplog/snapshot copies), keeps persistently and exposes as metadata; operator duties."
tags: [v2, privacy, operations, concept]
sources: []
updated: 2026-11-13
---

# What the v2 server sees and keeps

**Status: per [`docs/protocol.md`](../../docs/protocol.md) rev 2.1, §15 (meant to be told to users and operators);
implemented as of 2026-11-13. `fixes-server/README.md` repeats it with operator duties; the app's Settings screen
shows a summary.**

- **Never**: message bodies, receipt contents, history, backups, device and identity secret keys, the QR transfer
  secret, the recovery key.
- **Transiently**: ciphertext envelopes with sender/recipient user and device ids, timestamps and sizes (padded to
  256-byte buckets), until acked or for at most 30 days.
- **Persistently**: accounts (username, password hash, avatar, identity public key), devices (name, public key,
  certificate, last seen, revocation time; never deleted), friendships and pending requests.
- **Metadata**: who talks to whom and when, approximate sizes, receipt timing, device counts, last-seen times, client
  IPs in access logs.
- **Outside the server**: backup files wherever the user saves them, protected by the 120-bit recovery key; OS backups
  hold only SQLCipher ciphertext whose key never leaves the phone. Revoking a lost phone does not erase history
  already on it.

## Gotcha: deleted is not gone

Acked envelopes can survive in MongoDB's oplog (replica sets) and host/Atlas snapshots for their retention period.
With no forward secrecy, a later theft of a device secret key could decrypt those copies (history transfers are
protected by the deleted QR secret). Operators should keep oplog windows small, exclude the database from long-lived
snapshots where possible, and never log request bodies or tokens. A standalone MongoDB, as in the compose file, has no
oplog. The server keeps `pymongo`/`boto3`/`botocore` loggers at `WARNING` even with `FIXES_LOG_LEVEL=DEBUG`, since
their debug output would contain password hashes and ciphertext; Uvicorn's access log still records client IPs and
query strings such as user searches.

Related: [v2 architecture](v2-architecture.md), [v2 multi-device E2EE](v2-multi-device-e2ee.md),
[v2 history transfer and backups](v2-history-transfer-and-backups.md), [fixes-server](fixes-server.md).
