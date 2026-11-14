"""User lookup and search (protocol §5.3 Users)."""

from __future__ import annotations

import re
from collections.abc import Iterable

from pymongo import ASCENDING

from fixes_server.context import AppContext
from fixes_server.documents import UserDoc
from fixes_server.errors import not_found

SEARCH_LIMIT = 20


async def get_user(ctx: AppContext, user_id: str) -> UserDoc:
    user = await ctx.db.users.find_one({"_id": user_id})
    if user is None:
        raise not_found("User not found")
    return user


async def users_by_id(ctx: AppContext, user_ids: Iterable[str]) -> dict[str, UserDoc]:
    ids = sorted(set(user_ids))
    if not ids:
        return {}
    users = await ctx.db.users.find({"_id": {"$in": ids}}).to_list()
    return {user["_id"]: user for user in users}


async def search_users(ctx: AppContext, query: str, exclude_user_id: str) -> list[UserDoc]:
    # The query is already restricted to [A-Za-z0-9_], but escaping keeps the regex literal
    # even if that validation ever changes.
    cursor = (
        ctx.db.users.find(
            {
                "username_lower": {"$regex": re.escape(query.lower())},
                "_id": {"$ne": exclude_user_id},
            }
        )
        .sort([("username_lower", ASCENDING), ("_id", ASCENDING)])
        .limit(SEARCH_LIMIT)
    )
    return await cursor.to_list()


async def lookup_users(ctx: AppContext, user_ids: list[str]) -> list[UserDoc]:
    """Users in request order; unknown ids are omitted."""
    found = await users_by_id(ctx, user_ids)
    return [found[user_id] for user_id in user_ids if user_id in found]
