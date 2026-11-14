"""``GET /healthz`` (protocol §5.3 Health)."""

from __future__ import annotations

import logging

import anyio
from fastapi import APIRouter
from pymongo.errors import PyMongoError

from fixes_server.deps import Ctx
from fixes_server.errors import ApiError
from fixes_server.models.common import HealthStatus

logger = logging.getLogger(__name__)
router = APIRouter(tags=["health"])

PING_TIMEOUT_SECONDS = 3


@router.get("/healthz", responses={503: {"description": "MongoDB is unreachable"}})
async def healthz(ctx: Ctx) -> HealthStatus:
    try:
        # Bounded so orchestrator probes get a quick 503 instead of waiting for server selection.
        with anyio.fail_after(PING_TIMEOUT_SECONDS):
            await ctx.mongo.admin.command("ping")
    except (PyMongoError, TimeoutError) as exc:
        logger.warning("health check failed: %s", type(exc).__name__)
        raise ApiError(503, "service_unavailable", "Database unavailable") from None
    return HealthStatus()
