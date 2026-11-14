"""Friendship endpoints (protocol §5.3 Friends)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Response, status

from fixes_server.deps import Ctx, CurrentPrincipal
from fixes_server.ids import UUID4_PATTERN
from fixes_server.models.friends import (
    CreateFriendRequest,
    FriendList,
    FriendRequestAccepted,
    FriendRequestLists,
    FriendRequestPending,
    FriendResponse,
)
from fixes_server.services import friends as friends_service
from fixes_server.services.presenters import friend_request_out, user_out
from fixes_server.services.users import users_by_id

router = APIRouter(prefix="/v1", tags=["friends"])

UserId = Annotated[str, Path(pattern=UUID4_PATTERN)]
RequestId = Annotated[str, Path(pattern=UUID4_PATTERN)]


@router.get("/friends")
async def list_friends(principal: CurrentPrincipal, ctx: Ctx) -> FriendList:
    friends = await friends_service.list_friends(ctx, principal.user_id)
    return FriendList(friends=[user_out(u, ctx.storage) for u in friends])


@router.delete("/friends/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unfriend(user_id: UserId, principal: CurrentPrincipal, ctx: Ctx) -> Response:
    await friends_service.unfriend(ctx, principal.user_id, user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/friend-requests")
async def list_friend_requests(principal: CurrentPrincipal, ctx: Ctx) -> FriendRequestLists:
    incoming, outgoing, users = await friends_service.list_requests(ctx, principal.user_id)
    return FriendRequestLists(
        incoming=[friend_request_out(r, users, ctx.storage) for r in incoming],
        outgoing=[friend_request_out(r, users, ctx.storage) for r in outgoing],
    )


@router.post(
    "/friend-requests",
    status_code=status.HTTP_201_CREATED,
    responses={200: {"model": FriendRequestAccepted, "description": "Reciprocal request accepted"}},
)
async def create_friend_request(
    body: CreateFriendRequest, response: Response, principal: CurrentPrincipal, ctx: Ctx
) -> FriendRequestPending | FriendRequestAccepted:
    outcome = await friends_service.create_request(ctx, principal.user_id, body.to_user_id)
    if outcome.friend is not None:
        response.status_code = status.HTTP_200_OK
        return FriendRequestAccepted(friend=user_out(outcome.friend, ctx.storage))
    if outcome.request is None:
        raise RuntimeError("friend request outcome is empty")
    users = await users_by_id(ctx, [principal.user_id, body.to_user_id])
    return FriendRequestPending(
        friend_request=friend_request_out(outcome.request, users, ctx.storage)
    )


@router.post("/friend-requests/{request_id}/accept")
async def accept_friend_request(
    request_id: RequestId, principal: CurrentPrincipal, ctx: Ctx
) -> FriendResponse:
    friend = await friends_service.accept_request(ctx, principal.user_id, request_id)
    return FriendResponse(friend=user_out(friend, ctx.storage))


@router.delete("/friend-requests/{request_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_friend_request(
    request_id: RequestId, principal: CurrentPrincipal, ctx: Ctx
) -> Response:
    await friends_service.delete_request(ctx, principal.user_id, request_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
