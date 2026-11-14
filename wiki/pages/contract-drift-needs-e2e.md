---
title: Unit tests miss contract drift
type: gotcha
summary: "Server tests and app tests (against FakeFixesServer) each pass on their own reading of protocol.md; only the e2e suite against the real server catches drift (it found a stale cached device list dropping a reset contact's first message), and since it uses Node adapters, device-runtime drift such as an avatar upload expo/fetch cannot encode escapes it too."
tags: [v2, testing, e2e, protocol, gotcha]
sources: []
updated: 2026-11-13
---

# Unit tests miss contract drift

## Pitfall

`fixes-server` tests check the server against its reading of [`docs/protocol.md`](../../docs/protocol.md);
`fixes-app` tests run the core against `FakeFixesServer` (`src/test-utils/fakeServer/`), which encodes the app's
reading. Neither suite can see that the two readings, or the fake and the real server, disagree, nor bugs that only
appear with real timing and caching across both sides.

## Example (found by the e2e suite, 2026-11)

After bob reset his identity, alice's `DeviceDirectory` still held bob's device list cached (60 s) under the old AIK.
Bob's new device, certified by the new AIK, failed verification against that list and his first message was dropped
as coming from an ineligible sender. Fix in `src/core/trust/deviceDirectory.ts` `resolveSender` (as of 2026-11-13): if
a single-device lookup does not verify against a list that was cached before the call, reload the list once (which
moves the new key to `pending`, §8) and judge again.

## Drift even e2e misses (code-review round 2, 2026-11)

The e2e suite runs the core with Node adapters, so it cannot see wrong assumptions about the device runtime. The
avatar upload sent a React Native `{uri}` FormData part that Expo's global `fetch` cannot encode: it would have failed
on every real device while every test passed, and only a reviewer comparing what the app sends with what the server
parses found it ([expo/fetch pitfalls](expo-fetch-pitfalls.md)).

## Rule

Run the [e2e suite](run-e2e-suite.md) after changing the protocol, the API client, `FakeFixesServer` or server
endpoints. When it reveals a disagreement, fix `docs/protocol.md` first, then both sides and the fake. Test
`src/platform` adapters against the real Expo implementation (only the native module mocked), or on a device.

Related: [fixes-app](fixes-app.md), [fixes-server](fixes-server.md), [v2 account identity key](v2-account-identity-key.md).
