"""Avatar replacement (protocol §5.3 ``PUT /v1/users/me/avatar``)."""

from __future__ import annotations

import logging

from fastapi import UploadFile
from pymongo import ReturnDocument

from fixes_server.blocking import run_blocking
from fixes_server.context import AppContext
from fixes_server.documents import UserDoc
from fixes_server.errors import bad_request, not_found, payload_too_large
from fixes_server.images import MAX_AVATAR_BYTES, InvalidImageError, process_avatar
from fixes_server.ratelimit import enforce
from fixes_server.storage import new_avatar_key

logger = logging.getLogger(__name__)

_READ_CHUNK = 64 * 1024


async def read_limited(upload: UploadFile, limit: int = MAX_AVATAR_BYTES) -> bytes:
    """Read the upload while counting, so the limit holds even without a Content-Length."""
    chunks: list[bytes] = []
    total = 0
    while chunk := await upload.read(_READ_CHUNK):
        total += len(chunk)
        if total > limit:
            raise payload_too_large(f"Images must be at most {limit // (1024 * 1024)} MiB")
        chunks.append(chunk)
    return b"".join(chunks)


async def replace_avatar(ctx: AppContext, user_id: str, upload: UploadFile) -> UserDoc:
    enforce((ctx.rate_limits.avatar, user_id))
    data = await read_limited(upload)
    try:
        jpeg = await run_blocking(ctx.blocking, process_avatar, data)
    except InvalidImageError as exc:
        raise bad_request("invalid_image", str(exc)) from None

    # New object first, then the pointer, then the old object: a crash at any point leaves
    # the user with a working avatar (at worst an orphaned file).
    key = new_avatar_key()
    await ctx.storage.put_avatar(key, jpeg)
    before = await ctx.db.users.find_one_and_update(
        {"_id": user_id}, {"$set": {"avatar_key": key}}, return_document=ReturnDocument.BEFORE
    )
    if before is None:
        await ctx.storage.delete_avatar(key)
        raise not_found("User not found")
    old_key = before["avatar_key"]
    if old_key:
        try:
            await ctx.storage.delete_avatar(old_key)
        except Exception:
            # The new avatar is already live; a leftover old object is only wasted space.
            logger.warning("could not delete a replaced avatar object", exc_info=True)
    return {**before, "avatar_key": key}
