---
title: Legacy app (xamFixes/)
type: component
summary: The original Xamarin.Forms app (Android, iOS) with per-user local SQLite history and RSA-based E2EE over SignalR; reference only.
tags: [legacy, app, xamarin, e2ee]
sources: []
updated: 2026-11-13
---

# Legacy app (`xamFixes/`)

Kept untouched as reference for the planned [v2 rewrite](v2-architecture.md).

## Layout (`xamFixes/xamFixes.sln`)

- `xamFixes/xamFixes/`: shared Xamarin.Forms code: `Pages/`, `ViewModels/` (MVVM), `Services/` (HTTP clients; API
  base URL hard-coded in `Services/Base.cs`), `Repository/` (sqlite-net), `Crypto/`.
- `xamFixes.Android/`, `xamFixes.iOS/`: platform heads; `UITest/`: Xamarin.UITest scaffold.

## Local storage

One SQLite file per user, `{userId}.db3`, with tables `Conversation`, `UserInConversation`, `Message`
(`Repository/DBModel/`). Conversations are never stored server-side. The JWT is kept in `SecureStorage`
(`fixes_token`).

## E2EE (legacy scheme)

- `Crypto/Crypto.cs`: `RSACryptoServiceProvider` with the default 1024-bit key, PKCS#1 v1.5 padding, message text
  encoded as UTF-16.
- Ephemeral key pairs per conversation, exchanged through a live SignalR handshake (`SendHandshake` /
  `RespondHandshake` on the [Legacy API](legacy-api.md) hub); both parties must be online.
- Private keys stored in `SecureStorage`, keyed by a substring of the matching public key.

Replaced in v2 by [per-device X25519 keys](v2-multi-device-e2ee.md).

## Related

[Legacy defects](legacy-defects.md): the 58-character message limit, broken offline delivery and receipts, UI
miswirings.
