# FixesALL wiki — log

Append-only history of this wiki, newest entry at the bottom. Every entry starts with `## [YYYY-MM-DD] op | Title`
(ops: `init`, `seed`, `ingest`, `query`, `lint`, `update`); see [SCHEMA.md](SCHEMA.md).

## [2026-11-13] init | Wiki created

## [2026-11-13] update | Fixes v2 protocol spec (docs/protocol.md) and legacy code survey
- updated: overview.md (project, legacy layout, planned v2, stack, build notes)
- created: pages/legacy-api.md (Fixes/ .NET API component)
- created: pages/legacy-app.md (xamFixes/ Xamarin app component)
- created: pages/legacy-defects.md (gotcha: known legacy breakages)
- created: pages/v2-architecture.md (decision: FastAPI + MongoDB relay, Expo app, single instance)
- created: pages/v2-multi-device-e2ee.md (decision: per-device X25519 E2EE, TOFU, token rotation)
- created: pages/v2-history-transfer-and-backups.md (decision: QR history transfer, passphrase backups)
- updated: index.md

## [2026-11-13] update | Fixes v2 protocol revision 2 (docs/protocol.md) after design review
- updated: overview.md (rev 2 status, implementation in progress, new pages, dev build)
- updated: pages/v2-architecture.md (single process, worker threads, abuse limits, friendship-gated messaging, no transactions, dev build, parity §14)
- updated: pages/v2-multi-device-e2ee.md (certified-device eligibility, padding, revoked-sender key lookup; sessions moved out)
- updated: pages/v2-history-transfer-and-backups.md (linking flow, QR transfer-key layer, attempt ids, recovery key replaces passphrase + scrypt)
- updated: pages/legacy-defects.md (v2 status line)
- created: pages/v2-account-identity-key.md (decision: AIK + device certificates, reset identity, rejected signed device list, residual risk)
- created: pages/v2-delivery-reliability.md (decision: refresh grace, idle revocation, mailbox caps, completeness, outbox, receipts)
- created: pages/v2-server-visibility.md (concept: §15 what the server sees and keeps, oplog/snapshot caveat)
- created: pages/expo-os-backups-leak-app-data.md (gotcha: Expo defaults leak app data into OS backups; SQLCipher mitigation)
- updated: index.md

## [2026-11-13] update | v2 implemented: fixes-server, fixes-app, protocol rev 2.1
- updated: overview.md (v2 implemented, rev 2.1, component and guide links, licence not chosen, stack)
- updated: pages/v2-architecture.md (status, crash-safe write orders, monotonic envelope ids, SDK 57, rev 2.1 limits and error codes)
- updated: pages/v2-account-identity-key.md (status, own AIK for safety codes, Devices screen)
- updated: pages/v2-multi-device-e2ee.md (status, padding edge cases, per-direction key cache)
- updated: pages/v2-delivery-reliability.md (status, rev 2.1 signed-out signals, 4 MiB pages, socket order and close codes)
- updated: pages/v2-history-transfer-and-backups.md (status, Receive history on a linked device)
- updated: pages/v2-server-visibility.md (status, standalone has no oplog, logger levels)
- updated: pages/expo-os-backups-leak-app-data.md (implemented, raw-key PRAGMA, manifest test)
- updated: pages/legacy-defects.md (v2 status line)
- created: pages/fixes-server.md (component)
- created: pages/fixes-app.md (component)
- created: pages/expo-sdk-57-pin.md (decision: SDK 57 for Node 20, expo-font/expo-asset pin)
- created: pages/run-server-locally.md, pages/run-server-tests.md, pages/run-app-checks.md, pages/run-e2e-suite.md, pages/app-development-build.md (guides)
- created: pages/safety-code-from-local-identity-key.md, pages/jpeg-scan-bombs.md, pages/rate-limiter-o1-eviction.md, pages/login-password-change-race.md, pages/contract-drift-needs-e2e.md, pages/windows-dev-environment-notes.md (gotchas)
- updated: index.md

## [2026-11-13] update | Code-review round 2 fixes; e2e README steps match the 18 tests
- created: pages/expo-fetch-pitfalls.md (gotcha: expo/fetch cannot encode {uri} FormData parts; one deadline for fetch + body read)
- created: pages/fastapi-parses-body-before-auth.md (gotcha: body parsed before auth; per-account, server-wide and per-device concurrency caps, not in protocol §5.6)
- updated: pages/fixes-server.md (middleware row, known limitations, round-2 status)
- updated: pages/fixes-app.md (platform adapters vs real expo/fetch, round-2 status)
- updated: pages/v2-account-identity-key.md (own devices judged only under the install's AIK; lost reset response triggers a quiet re-check)
- updated: pages/v2-delivery-reliability.md (4401 always makes a real refresh round trip)
- updated: pages/contract-drift-needs-e2e.md (device-runtime drift the e2e suite misses; summary)
- updated: pages/v2-architecture.md (concurrency caps link, round-2 status)
- updated: pages/run-e2e-suite.md (Node adapters only; README steps = 18 tests)
- updated: index.md

## [2026-11-13] update | Protocol rev 2.2 and code-review round 3 fixes
- created: pages/bounded-validation-errors.md (gotcha: 34 MB 422 from unknown keys; 20-field cap, omitted_fields, MAX_UNKNOWN_KEYS pre-check)
- updated: pages/fastapi-parses-body-before-auth.md (slot wait/send deadlines vs pipelining clients, caps now in protocol §5.7, run behind a proxy; summary)
- updated: pages/fixes-server.md (rev 2.2, round 3 status, errors.py row, reverse-proxy-only deployment, remaining exposure)
- updated: pages/v2-architecture.md (rev 2.2 status and additions, review rounds 40 → 9 → 4, proxy rule; summary)
- updated: pages/v2-multi-device-e2ee.md (rev 2.2 §13 rule: one counting undecryptable notice per contact, system messages leave unread/activity alone; app implementation in progress)
- updated: pages/v2-delivery-reliability.md (rev 2.2 status, permanent-failure bullet pointing to the §13 rule; summary)
- updated: pages/v2-account-identity-key.md (reset retry reuses the pending key)
- updated: pages/fixes-app.md (rev 2.2, round 3 status, §13 rule in progress)
- updated: overview.md (rev 2.2, review status; summary)
- updated: index.md

## [2026-11-13] update | §13 collapsed undecryptable notices implemented and verified
- created: pages/undecryptable-notices.md (decision: run kept in the notice row, no schema change; per-contact cursor, 14.8 s → 0.2 s; inexact count after restart; no row deletes/VACUUM gotcha)
- updated: pages/v2-multi-device-e2ee.md (§13 rule implemented and verified, link)
- updated: pages/fixes-app.md (status and verified numbers, 505 tests, no-delete/VACUUM rule)
- updated: pages/fixes-server.md (verified numbers, 331 tests)
- updated: pages/v2-delivery-reliability.md (status no longer "in progress", link)
- updated: pages/v2-architecture.md (status)
- updated: pages/run-server-tests.md, pages/run-app-checks.md (test counts; summaries)
- updated: pages/run-e2e-suite.md (flood step expects one counting notice; 18/18 on 2026-11-13)
- updated: overview.md (status rows with verified numbers)
- updated: index.md
