"""Friendships and friend requests (protocol §5.3 Friends).

Writes follow the crash-safe order of the spec: the friendship (``_id = pair_key``, so a
duplicate insert means "already done") is written before the request is deleted. A crash in
between leaves a request that can simply be accepted again.
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass

from pymongo import ASCENDING
from pymongo.errors import DuplicateKeyError

from fixes_server.context import AppContext
from fixes_server.documents import FriendRequestDoc, FriendshipDoc, UserDoc
from fixes_server.errors import bad_request, conflict, not_found
from fixes_server.ids import new_id, pair_key
from fixes_server.ratelimit import enforce
from fixes_server.services.users import get_user, users_by_id
from fixes_server.timeutil import utcnow


async def are_friends(ctx: AppContext, user_a: str, user_b: str) -> bool:
    return await ctx.db.friendships.find_one({"_id": pair_key(user_a, user_b)}) is not None


async def list_friends(ctx: AppContext, user_id: str) -> list[UserDoc]:
    friendships = await ctx.db.friendships.find({"user_ids": user_id}).to_list()
    friend_ids = {uid for f in friendships for uid in f["user_ids"] if uid != user_id}
    users = await users_by_id(ctx, friend_ids)
    return sorted(users.values(), key=lambda u: (u["username_lower"], u["_id"]))


async def unfriend(ctx: AppContext, user_id: str, friend_id: str) -> None:
    result = await ctx.db.friendships.delete_one({"_id": pair_key(user_id, friend_id)})
    if result.deleted_count == 0:
        raise not_found("Not friends with that user")


async def _befriend(ctx: AppContext, request: FriendRequestDoc) -> None:
    # A duplicate _id means the friendship already exists, which is the desired end state.
    with contextlib.suppress(DuplicateKeyError):
        await ctx.db.friendships.insert_one(
            FriendshipDoc(
                _id=request["pair_key"],
                user_ids=sorted((request["from_user_id"], request["to_user_id"])),
                created_at=utcnow(),
            )
        )
    await ctx.db.friend_requests.delete_one({"_id": request["_id"]})


@dataclass(frozen=True, slots=True)
class RequestOutcome:
    """Either a new pending request or an immediate friendship (reciprocal request)."""

    request: FriendRequestDoc | None = None
    friend: UserDoc | None = None


async def create_request(ctx: AppContext, from_user_id: str, to_user_id: str) -> RequestOutcome:
    enforce((ctx.rate_limits.friend_requests, from_user_id))
    if to_user_id == from_user_id:
        raise bad_request("cannot_friend_self", "You cannot add yourself as a friend")
    target = await get_user(ctx, to_user_id)
    if await are_friends(ctx, from_user_id, to_user_id):
        raise conflict("already_friends", "You are already friends")

    key = pair_key(from_user_id, to_user_id)
    for _ in range(2):
        existing = await ctx.db.friend_requests.find_one({"pair_key": key})
        if existing is not None:
            if existing["from_user_id"] == from_user_id:
                raise conflict("request_exists", "You already sent a friend request")
            # They already asked us: accept instead of creating a mirror request.
            await _befriend(ctx, existing)
            return RequestOutcome(friend=target)
        request = FriendRequestDoc(
            _id=new_id(),
            from_user_id=from_user_id,
            to_user_id=to_user_id,
            pair_key=key,
            created_at=utcnow(),
        )
        try:
            await ctx.db.friend_requests.insert_one(request)
        except DuplicateKeyError:
            continue  # A request for this pair appeared concurrently; re-read and decide.
        return RequestOutcome(request=request)
    raise conflict("request_exists", "A friend request between you already exists")


async def list_requests(
    ctx: AppContext, user_id: str
) -> tuple[list[FriendRequestDoc], list[FriendRequestDoc], dict[str, UserDoc]]:
    order = [("created_at", ASCENDING), ("_id", ASCENDING)]
    incoming = await ctx.db.friend_requests.find({"to_user_id": user_id}).sort(order).to_list()
    outgoing = await ctx.db.friend_requests.find({"from_user_id": user_id}).sort(order).to_list()
    user_ids = {r["from_user_id"] for r in incoming} | {r["to_user_id"] for r in outgoing}
    users = await users_by_id(ctx, user_ids | {user_id})
    # Requests whose other party no longer exists cannot be rendered; leave them out.
    incoming = [r for r in incoming if r["from_user_id"] in users]
    outgoing = [r for r in outgoing if r["to_user_id"] in users]
    return incoming, outgoing, users


async def accept_request(ctx: AppContext, user_id: str, request_id: str) -> UserDoc:
    request = await ctx.db.friend_requests.find_one({"_id": request_id, "to_user_id": user_id})
    if request is None:
        raise not_found("Friend request not found")
    friend = await get_user(ctx, request["from_user_id"])
    await _befriend(ctx, request)
    return friend


async def delete_request(ctx: AppContext, user_id: str, request_id: str) -> None:
    """Decline (as recipient) or cancel (as sender)."""
    result = await ctx.db.friend_requests.delete_one(
        {"_id": request_id, "$or": [{"to_user_id": user_id}, {"from_user_id": user_id}]}
    )
    if result.deleted_count == 0:
        raise not_found("Friend request not found")
