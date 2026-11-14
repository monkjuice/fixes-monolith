"""``/v1/ws``: the realtime socket (protocol §6). The protocol lives in realtime/session.py."""

from __future__ import annotations

from fastapi import APIRouter, WebSocket

from fixes_server.deps import Ctx
from fixes_server.realtime.session import serve_socket

router = APIRouter(tags=["realtime"])


@router.websocket("/v1/ws")
async def websocket_endpoint(websocket: WebSocket, ctx: Ctx) -> None:
    # No token in the URL (it would end up in access logs); auth is the first frame.
    await serve_socket(ctx, websocket)
