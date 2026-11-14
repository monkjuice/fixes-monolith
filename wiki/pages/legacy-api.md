---
title: Legacy API (Fixes/)
type: component
summary: The original .NET Core 3.1 backend: REST API, SignalR chat relay, SQL Server and Azure Blob avatars; reference only.
tags: [legacy, api, dotnet, signalr]
sources: []
updated: 2026-11-13
---

# Legacy API (`Fixes/`)

Kept untouched as reference for the planned [v2 rewrite](v2-architecture.md); no further work is planned on it.

## Layout (`Fixes/Fixes.sln`)

- `FixesAPI/`: ASP.NET Core 3.1 controllers, validators, `RealTime/ChatHub.cs`, `Startup.cs`.
- `Service/`: business logic (`Services/*`), `Utils/Crypto.cs` (password hashing: SHA-512 + salt),
  `Utils/FileStorage.cs` (Azure Blob Storage for profile pictures).
- `Repository/`: EF Core on SQL Server (`FixesContext.cs`, `Migrations/`).
- `Model/`: `User`, `Friendship`, `FriendshipRequest`.
- `MessageBroadcaster*/`: stub Azure WebJobs projects; `CryptoTest/`: console experiment; `TestAPI/`: console client
  that calls the endpoints.

## Interfaces

- JWT bearer auth, 120-minute tokens with claims `userid` and `username`.
- REST: `POST /login`, `POST /register`, `GET /api/home`, `GET /api/user/profile`,
  `POST /api/user/uploadprofilepicture`, `GET /api/user/findusers`, `POST /api/friendship/createrequest`,
  `POST /api/friendship/acceptrequest`, `GET /api/friendship/friendslist`.
- SignalR hub at `/chathub`: each connection joins a group named after its username; `SendChatMessage`,
  `QueueChatMessage`, `SendHandshake`, `RespondHandshake` just forward to the target user's group. The server stores
  no messages.

## Configuration

Connection strings `DefaultConnection` (SQL Server) and `AzureStorage` come from `ConnectionStrings.config`, referenced
by `App.config` but not in the repository. JWT settings: `Jwt:Key`, `Jwt:Issuer` in `appsettings.json`.

## Related

[Legacy app](legacy-app.md) (its only client), [Legacy defects](legacy-defects.md) (missing endpoints and hub methods,
authorization holes).
