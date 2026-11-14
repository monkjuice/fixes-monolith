---
title: Expo defaults put app data in OS cloud backups
type: gotcha
summary: "Expo defaults (android.allowBackup true, keychain WHEN_UNLOCKED) silently copy app data such as a plaintext SQLite chat history to iCloud/Google backups; v2 uses SQLCipher, device-only keys and allowBackup false, which requires an Expo development build."
tags: [expo, react-native, privacy, backup, gotcha, v2]
sources: []
updated: 2026-11-13
---

# Expo defaults put app data in OS cloud backups

Applies to any privacy-sensitive Expo app. Found in the rev 2 design review of
[`docs/protocol.md`](../../docs/protocol.md) (§12.1); the v2 mitigation is implemented in [fixes-app](fixes-app.md)
as of 2026-11-13 (`src/platform/database.ts`, `src/platform/secureStore.ts`, `app.json`).

## Pitfall

- Expo Android builds default to `android.allowBackup: true`, so Android Auto Backup copies app files, including
  SQLite databases, to the user's Google account.
- iOS iCloud Backup includes the app's data, and `expo-secure-store`'s default keychain accessibility
  (`WHEN_UNLOCKED`) is not device-only.
- Nothing warns about this. Rev 1 of v2 would have uploaded the plaintext chat history to Apple/Google, breaking
  "history lives only on your devices".

## v2 mitigation

- Local DB encrypted with **SQLCipher**: `useSQLCipher: true` in the expo-sqlite config plugin; key = 32 random bytes in
  secure storage (`fixes.dbkey.<user_id>`), applied with `PRAGMA key` in raw-key form (`x'<64 hex>'`, skipping
  SQLCipher's passphrase KDF) right after opening. The app refuses to run if `PRAGMA cipher_version` is empty
  (SQLCipher not actually linked).
- Every secure-store item uses `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so keys never travel in backups.
- `app.json`: `android.allowBackup: false`; the generated Android manifest is checked by
  `src/platform/__tests__/appConfig.test.ts`, and `npx expo config --type introspect` shows the effective settings.
- A DB file present without its key (restored from an OS backup) is moved aside; the app starts empty and offers
  backup import or device linking.

## Consequence

SQLCipher needs native configuration, so `fixes-app/` runs as an Expo **development build**; Expo Go is not supported
([Make an app development build](app-development-build.md)).
History recovery uses the app's own [recovery-key backups](v2-history-transfer-and-backups.md) instead.

Related: [v2 architecture](v2-architecture.md), [What the v2 server sees and keeps](v2-server-visibility.md).
