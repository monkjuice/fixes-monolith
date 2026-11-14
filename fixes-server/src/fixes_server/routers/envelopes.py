"""``/v1/envelopes``: the ciphertext relay (protocol §5.3 Envelopes)."""

from __future__ import annotations

import json
from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response, status
from fastapi.routing import APIRoute

from fixes_server.deps import Ctx, CurrentPrincipal
from fixes_server.errors import validation_error
from fixes_server.models.envelopes import (
    DEFAULT_FETCH_LIMIT,
    MAX_FETCH_LIMIT,
    AckRequest,
    EnvelopeList,
    SendEnvelopesRequest,
    SendEnvelopesResponse,
    has_too_many_keys,
)
from fixes_server.services import envelopes as envelopes_service
from fixes_server.services.presenters import envelope_out

router = APIRouter(prefix="/v1/envelopes", tags=["envelopes"])


class _BatchRequest(Request):
    async def json(self) -> Any:
        if not hasattr(self, "_json"):
            batch = json.loads(await self.body())
            if has_too_many_keys(batch):
                del batch  # not kept alive by the traceback while the 422 is sent
                raise validation_error({"body": "has too many fields"})
            self._json = batch
        return self._json


class _BatchRoute(APIRoute):
    """Checks a batch with :func:`has_too_many_keys` right after FastAPI decodes it, before
    pydantic validates it; the route keeps its typed body (and its OpenAPI schema)."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def checked_handler(request: Request) -> Response:
            return await handler(_BatchRequest(request.scope, request.receive))

        return checked_handler


async def send_envelopes(
    body: SendEnvelopesRequest, principal: CurrentPrincipal, ctx: Ctx
) -> SendEnvelopesResponse:
    result = await envelopes_service.send_envelopes(
        ctx, principal, body.envelopes, body.complete_for_user_ids
    )
    return SendEnvelopesResponse(
        ids=result.ids,
        created_at=result.created_at,
        dropped_device_ids=result.dropped_device_ids,
    )


router.add_api_route(
    "",
    send_envelopes,
    methods=["POST"],
    status_code=status.HTTP_201_CREATED,
    route_class_override=_BatchRoute,
)


@router.get("")
async def fetch_envelopes(
    principal: CurrentPrincipal,
    ctx: Ctx,
    limit: Annotated[int, Query(ge=1, le=MAX_FETCH_LIMIT)] = DEFAULT_FETCH_LIMIT,
) -> EnvelopeList:
    envelopes, gap = await envelopes_service.fetch_pending(ctx, principal.device_id, limit)
    return EnvelopeList(envelopes=[envelope_out(e) for e in envelopes], gap=gap)


@router.post("/ack", status_code=status.HTTP_204_NO_CONTENT)
async def ack_envelopes(body: AckRequest, principal: CurrentPrincipal, ctx: Ctx) -> Response:
    await envelopes_service.ack_envelopes(ctx, principal.device_id, body.ids)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
