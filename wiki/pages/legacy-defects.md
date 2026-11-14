---
title: Legacy defects
type: gotcha
summary: Known breakages in the legacy API and app (58-char message limit, no offline delivery, missing hub methods, authorization holes) that v2 must not copy.
tags: [legacy, gotcha, security, e2ee]
sources: []
updated: 2026-11-13
---

# Legacy defects

Found by reading `Fixes/` and `xamFixes/` (2026-11). Do not treat legacy behaviour as a spec where it hits these.

## Chat

- **~58-character messages.** RSA-1024 with PKCS#1 v1.5 encrypts at most 117 bytes; text is UTF-16 (2 bytes per
  char), so longer messages fail (`xamFixes/xamFixes/Crypto/Crypto.cs`).
- **Offline delivery never worked.** When the peer is offline the app calls `/api/inbox/queuemessage`
  (`Services/InboxService.cs`), which the API does not have.
- **Receipts never worked.** The app invokes hub methods `ReadMessage` / `RecievedMessage` and listens for
  `RecipientRecievedMessage` / `RecipientReadMessage` (`ViewModels/InboxViewModel.cs`, `ConversationViewModel.cs`);
  `Fixes/FixesAPI/RealTime/ChatHub.cs` implements none of them.

## API authorization

- `POST /api/friendship/acceptrequest` has no check that the caller is the request's recipient: anyone can accept any
  request id (`FriendshipController.cs`, `FriendshipService.AcceptRequest`).
- `GET /api/friendship/friendslist` takes an arbitrary `userId` query parameter, so anyone can list anyone's friends.

## App UI

- The "Add as known" button on `Pages/Profile/ProfilePage.xaml` is bound to `LogoutCommand`: it logs the user out.
- `App.xaml.cs` has `devMode = true`, which removes the stored token on every start (forced login each launch).
- The Home and New Post tabs are placeholders; New Post actually uploads a profile picture.

v2 drops the posts/feed tabs (non-goal) and addresses the rest by design: see
[v2 multi-device E2EE](v2-multi-device-e2ee.md) (no length limit from RSA, offline mailbox, encrypted receipts) and
[`docs/protocol.md`](../../docs/protocol.md) §5.3 (recipient-only accept, friends list of the caller only); all per
`docs/protocol.md` rev 2.1, implemented in [fixes-server](fixes-server.md) and [fixes-app](fixes-app.md) as of
2026-11-13.

Related: [Legacy API](legacy-api.md), [Legacy app](legacy-app.md).
