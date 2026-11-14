---
title: Expo's global fetch (expo/fetch) pitfalls
type: gotcha
summary: "On iOS/Android Expo SDK 57 replaces the global fetch with expo/fetch, which cannot encode React Native {uri, name, type} FormData file parts (avatar upload failed on every real device while all tests passed) and resolves at the response headers with no read timeout, so the app's deadline must also cover the body read."
tags: [v2, app, expo, networking, gotcha]
sources: []
updated: 2026-11-13
---

# Expo's global fetch (expo/fetch) pitfalls

Found by code-review round 2 (2026-11); fixed as of 2026-11-13. On iOS and Android, Expo SDK 57 installs `expo/fetch`
as the global `fetch` (`expo/src/winter/runtime.native.ts`). The core tests and the [e2e suite](run-e2e-suite.md) use
Node adapters, so neither pitfall showed up in any test.

## File parts in FormData

`expo/fetch` encodes a FormData part from a string, a `Blob` or an object with `bytes()`, never React Native's
`{uri, name, type}` file part: avatar upload would have failed on every real device. `src/platform/httpUpload.ts` now
appends `{ name, type, bytes: () => new File(uri).bytes() }` (`File` from `expo-file-system`), cast to `Blob` because
the DOM typings do not know that shape. Do not turn it back into a `{uri}` part.

`src/platform/__tests__/httpUpload.test.ts` guards this by running the real `expo/fetch` with React Native's FormData
patched as Expo patches it, mocking only the native request module. Test other platform adapters the same way.

## Timeouts must cover the body

`expo/fetch` resolves once the response headers arrive, and the native stacks set no read timeout, so a timer that
stops at the headers leaves a stalled body hanging forever. `src/core/api/http.ts` (`withTimeout`) applies one deadline
to the fetch and the body read; at the deadline it aborts the request and throws `NetworkError` `timeout`.

Related: [fixes-app](fixes-app.md), [Unit tests miss contract drift](contract-drift-needs-e2e.md),
[Expo SDK 57, not 58](expo-sdk-57-pin.md).
