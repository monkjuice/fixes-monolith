---
title: Collapsed undecryptable notices
type: decision
summary: "How fixes-app implements the protocol rev 2.2 §13 rule (one counting notice per run of undecryptable messages from a contact) with no schema change: the run lives in the notice row and a per-contact cursor makes each failure O(1); the count can be slightly off after a restart, and the lookup relies on message rows never being deleted or VACUUMed."
tags: [v2, app, e2ee, sqlite, decision, gotcha]
sources: []
updated: 2026-11-13
---

# Collapsed undecryptable notices

**Status: implemented and verified as of 2026-11-13** in `fixes-app/src/core/messaging/undecryptableNotices.ts`
(`UndecryptableNotices`, used by `envelopeProcessor.ts` and `receiveQueue.ts`), notice text and count parsing in
`conversationSummary.ts` (`undecryptableText`, `undecryptableCount`), row access in `src/core/db/repositories/messages.ts`
(`lastInsertedSystem`, `insertedSince`, `rowidOf`, `updateSystem`). The rule itself:
[v2 multi-device E2EE](v2-multi-device-e2ee.md). Full reasoning: `fixes-app/README.md`, "Protocol interpretations made
here".

## Choice

- **No schema change** (§12.2 stays at `user_version` 1): the run state is the notice row itself. A contact's newest
  notice (SQLite rowid order) is *open* until an incoming message from that contact is inserted after it (also one
  from a history or backup import; a duplicate that was not inserted does not end the run). The count lives in the
  body text; the notice keeps the id and `sort_ts` of its first failure, so it does not move; `server_ts` holds the
  `created_at` of the newest counted envelope.
- **Per-contact cursor**: finding the newest notice walks the whole conversation, so it is done once per contact and
  session; then an in-memory cursor (notice rowid, highest rowid checked) lets each failure check only the rows
  inserted since. A flood of 1 000 failures in a 60 000-row conversation went from ~14.8 s to ~0.2 s. The cursor is
  saved only after the page transaction commits (`commit()`), because a rolled-back transaction's rowids are handed
  out again; it is re-checked against the database and falls back to the full lookup.
- Each envelope counts once; exact within a session (counted envelope ids are remembered in memory).

## Known limit (README, pinned by tests)

After an app restart, redelivery of an applied-but-unacked page is detected by comparing the envelope's `created_at`
with the notice's `server_ts`. The server orders mailboxes by envelope id but takes `created_at` slightly earlier
(before the mailbox lock; one POST shares one `created_at`), so a hostile flood's count can be slightly off (usually
an undercount). An exact count would need a §12.2 column for the last counted envelope id.
`src/core/messaging/__tests__/undecryptableNotices.test.ts` pins the three README cases.

## Gotcha

The fast lookup assumes rowids only grow: the app never deletes message rows or runs `VACUUM` (either can reuse or
renumber rowids). A future "clear history" or compaction feature must revisit `UndecryptableNotices`.

The e2e flood step (`fixes-app/e2e/messaging.test.ts`) expects exactly one "1000 messages from <bob> could not be
decrypted" notice ([Run the e2e suite](run-e2e-suite.md)).

Related: [fixes-app](fixes-app.md), [v2 delivery reliability](v2-delivery-reliability.md).
