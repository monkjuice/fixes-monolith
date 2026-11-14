---
title: Make an app development build
type: guide
summary: "Build the fixes-app dev client with npx expo prebuild --clean + npx expo run:android (or run:ios, or EAS Build), then iterate with Metro; Expo Go is unsupported because the app requires SQLCipher."
tags: [v2, app, expo, guide, build]
sources: []
updated: 2026-11-13
---

# Make an app development build

Expo Go cannot run the app: expo-sqlite is compiled with SQLCipher and the app refuses to open its database when
`PRAGMA cipher_version` is empty ([Expo OS backups gotcha](expo-os-backups-leak-app-data.md)). Build a dev client once,
and again whenever native dependencies, `app.json` or config plugins change; JavaScript changes only need Metro.
As of 2026-11-13, per `fixes-app/README.md`.

## Local build

Needs Android Studio (SDK + JDK 17), or Xcode on macOS. From `fixes-app/`:

```sh
export EXPO_PUBLIC_API_URL=http://10.0.2.2:8000   # dev server, no /v1; 10.0.2.2 = host seen from the Android emulator
npx expo prebuild --clean   # generates android/ and ios/ (git-ignored) from app.json
npx expo run:android        # builds, installs the dev client, starts Metro; run:ios on macOS
npm start                   # later sessions: Metro for the installed dev client
```

- `EXPO_PUBLIC_API_URL` is inlined into the bundle: after changing it restart Metro (`npx expo start --clear`) or
  rebuild. Only `src/platform/config.ts` reads it.
- Release builds (`npx expo run:android --variant release`, `npx expo run:ios --configuration Release`) refuse any
  non-`https` URL.

## EAS Build

`npm install -g eas-cli` (deliberately not a project dependency), `eas login`, `eas build:configure` (creates
`eas.json`), then `eas build --profile development --platform android`. Pass `EXPO_PUBLIC_API_URL` through EAS
environment variables or the profile's `env` block.

## Before publishing

`android.package` / `ios.bundleIdentifier` (`app.fixes.mobile`) are placeholders. Check native security settings with
`npx expo config --type introspect`; `src/platform/__tests__/appConfig.test.ts` checks the generated Android manifest.

Related: [fixes-app](fixes-app.md), [Run the app checks](run-app-checks.md), [Expo SDK 57, not 58](expo-sdk-57-pin.md).
