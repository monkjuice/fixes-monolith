---
title: Run the server locally
type: guide
summary: "Run fixes-server from a virtual environment (Python 3.12+, MongoDB 7+, FIXES_JWT_SECRET) with Uvicorn's --factory fixes_server.main:app_from_env, or with Docker Compose and its s3/tls profiles."
tags: [v2, server, guide, run]
sources: []
updated: 2026-11-13
---

# Run the server locally

As of 2026-11-13, per `fixes-server/README.md`.

## Virtual environment

Needs Python 3.12+ (developed on 3.13) and a reachable MongoDB 7+. From `fixes-server/`:

```sh
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"            # .venv/bin/python outside Windows
export FIXES_JWT_SECRET="<32+ random characters>"         # required: the server refuses to start without it
export FIXES_MONGODB_URI=mongodb://127.0.0.1:27017
.venv/Scripts/python -m uvicorn --factory fixes_server.main:app_from_env \
    --host 127.0.0.1 --port 8000 --proxy-headers --ws-max-size 65536
```

- All settings are environment variables (`FIXES_*`, table in the README, placeholders in `example.env`); the server
  reads no configuration files. Avatars default to local storage (`data/media`, served at `/media`).
- Run **one** Uvicorn worker (in-memory state, see [fixes-server](fixes-server.md)). API docs at `/docs`; `/healthz`
  answers 503 `service_unavailable` while MongoDB is unreachable.
- The Android emulator reaches the host as `http://10.0.2.2:8000` (the app's `EXPO_PUBLIC_API_URL`).

## Docker Compose

```sh
cp example.env fixes.env          # never commit it; set FIXES_JWT_SECRET, FIXES_PUBLIC_BASE_URL
docker compose --env-file fixes.env up -d --build
curl http://127.0.0.1:8000/healthz
```

Add `--profile s3` for MinIO avatars or `--profile tls` for Caddy (set `FIXES_DOMAIN`). `FIXES_API_PUBLISH=0.0.0.0:8000`
exposes the API to a phone on the LAN (development only). The compose setup had not been executed as of 2026-11-13.

On Windows, Uvicorn's exit code after Ctrl+Break is misleading: see
[Windows development environment notes](windows-dev-environment-notes.md).

Related: [Run the server tests](run-server-tests.md), [Run the e2e suite](run-e2e-suite.md).
