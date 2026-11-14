"""Application factory.

Run with ``uvicorn --factory fixes_server.main:app_from_env`` (see README). Tests and tools
call :func:`create_app` with explicit settings.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import anyio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from fixes_server.config import Settings, load_settings
from fixes_server.context import build_context
from fixes_server.errors import install_error_handlers
from fixes_server.hooks import DeviceEventHooks
from fixes_server.middleware import BodySizeLimitMiddleware, EnvelopePageMiddleware
from fixes_server.realtime.protocol import CLOSE_SERVICE_RESTART
from fixes_server.routers import auth, devices, envelopes, friends, health, users, ws
from fixes_server.services.idle_sweep import run_idle_sweeper
from fixes_server.storage import MEDIA_MOUNT_PATH

API_VERSION = "2.0.0"


def create_app(settings: Settings, *, hooks: DeviceEventHooks | None = None) -> FastAPI:
    """Build the ASGI app. ``hooks`` observes device lifecycle events after the real
    realtime hooks have run (tests record them); see :mod:`fixes_server.hooks`."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        ctx = await build_context(settings, hooks)
        app.state.ctx = ctx
        try:
            # The lifespan is entered and exited by one task, so the task group's scope is
            # well nested; the sweeper never raises (it logs failures and retries hourly).
            async with anyio.create_task_group() as background:
                background.start_soon(run_idle_sweeper, ctx, name="idle-device-sweep")
                try:
                    yield
                finally:
                    # Sockets first: their handlers use MongoDB, which is closed below.
                    ctx.realtime.close_all(CLOSE_SERVICE_RESTART, "server shutting down")
                    background.cancel_scope.cancel()
        finally:
            await ctx.aclose()

    app = FastAPI(title="Fixes API", version=API_VERSION, lifespan=lifespan)
    install_error_handlers(app)

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(devices.router)
    app.include_router(users.router)
    app.include_router(friends.router)
    app.include_router(envelopes.router)
    app.include_router(ws.router)

    if settings.storage_backend == "local":
        # check_dir=False: the directory is created in the lifespan, after this mount exists.
        app.mount(
            MEDIA_MOUNT_PATH,
            StaticFiles(directory=settings.storage_local_dir, check_dir=False),
            name="media",
        )

    # Starlette runs the most recently added middleware first. CORS wraps the size limit so
    # that even a 413 or 429 carries CORS headers; the size limit still runs before any routing.
    app.add_middleware(EnvelopePageMiddleware)
    app.add_middleware(BodySizeLimitMiddleware)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )
    return app


# At DEBUG these log whole database commands and replies (password hashes, ciphertext) or
# request details; the server must never log request bodies or tokens (§15).
PINNED_LOGGERS = ("pymongo", "botocore", "boto3", "s3transfer", "urllib3")


def configure_logging(level: str) -> None:
    """``level`` applies to the server's own loggers; other libraries log at INFO at most,
    and the database and S3 clients at WARNING at most, whatever ``level`` says."""
    numeric = logging.getLevelNamesMapping()[level]
    logging.basicConfig(
        level=max(numeric, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("fixes_server").setLevel(numeric)
    for name in PINNED_LOGGERS:
        logging.getLogger(name).setLevel(max(numeric, logging.WARNING))


def app_from_env() -> FastAPI:
    """Uvicorn factory: reads FIXES_* variables and refuses to start if they are invalid."""
    settings = load_settings()
    configure_logging(settings.log_level)
    return create_app(settings)
