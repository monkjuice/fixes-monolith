---
title: Expo SDK 57, not 58
type: decision
summary: "fixes-app stays on Expo SDK 57 (React Native 0.86) because SDK 58 requires Node ≥ 22.13 and the dev machine has Node 20.19; expo-font and expo-asset are pinned as direct dependencies so npm does not resolve SDK 58 peers."
tags: [v2, app, expo, node, decision]
sources: []
updated: 2026-11-13
---

# Expo SDK 57, not 58

## Context

When `fixes-app/` was created (2026-11), Expo SDK 58 was the `latest` release but requires Node ≥ 22.13; the
development machine runs Node 20.19. SDK 57 / React Native 0.86 supports Node `^20.19.4`.

## Choice

Stay on SDK 57 until the toolchain moves to Node 22; recorded in `docs/protocol.md` §2. All versions are pinned exactly
(`.npmrc` `save-exact=true`).

## Consequences

- **Peer-resolution gotcha**: `@expo/vector-icons` needs `expo-font` as a peer; without a direct entry npm resolved it
  to the SDK 58 release, which cannot find `expo-asset`, and both Jest and Metro failed to load the icons. `expo-font`
  and `expo-asset` are therefore direct dependencies pinned to the versions SDK 57's `expo` uses: keep them in step on
  any SDK upgrade, and confirm with `npx expo install --check`.
- Upgrading to SDK 58 first needs Node ≥ 22.13 on every machine that builds or tests the app.

Related: [fixes-app](fixes-app.md), [v2 architecture](v2-architecture.md), [Run the app checks](run-app-checks.md).
