"""The envelope relay (protocol §5.3 Envelopes): checks, mailbox caps, storage and delivery.

The server only ever sees ciphertext. A batch is validated completely before anything is
stored (all-or-nothing), except that envelopes over a mailbox cap are dropped individually.

Write order of a batch, crash-safe without transactions:

1. ``overflow_at`` on devices that lose envelopes - a crash afterwards may report a gap that
   cost nothing, but can never hide one;
2. insert the accepted envelopes (one ordered ``insert_many``; a failure part-way leaves a
   prefix stored and answers 500, and the client's retry is deduplicated by message id);
3. delete them again for any recipient revoked meanwhile (see ``_discard_for_revoked``);
4. push them to connected recipients. Pushes are best effort: the mailbox is the source of
   truth and clients drain it after every (re)connect.

Counting and inserting run under per-device locks, so the caps are exact within this single
process (§2).
"""

from __future__ import annotations

import logging
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, cast

from bson import ObjectId
from pymongo import ASCENDING

from fixes_server.context import AppContext
from fixes_server.deps import Principal
from fixes_server.documents import DeviceDoc, EnvelopeDoc
from fixes_server.errors import conflict, device_not_linked, not_friends, payload_too_large
from fixes_server.ids import pair_key
from fixes_server.models.envelopes import MAX_CIPHERTEXT_BYTES, OutgoingEnvelope
from fixes_server.ratelimit import enforce
from fixes_server.realtime import protocol
from fixes_server.services.presenters import envelope_out
from fixes_server.timeutil import utcnow

logger = logging.getLogger(__name__)

MAX_PENDING_PER_DEVICE = 5_000
MAX_PENDING_PER_SENDER = 1_000
# Raw ciphertext per GET page. 500 envelopes of 64 KiB would be a ~44 MB response built in
# memory (and mostly on the event loop); this keeps a page at a few MB of JSON.
MAX_FETCH_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class SendResult:
    ids: list[str | None]
    created_at: datetime
    dropped_device_ids: list[str]


async def send_envelopes(
    ctx: AppContext,
    principal: Principal,
    envelopes: Sequence[OutgoingEnvelope],
    complete_for_user_ids: Sequence[str] = (),
) -> SendResult:
    # Cheap size check first, so an invalid batch does not spend the sender's budget.
    if any(len(envelope.ciphertext) > MAX_CIPHERTEXT_BYTES for envelope in envelopes):
        raise payload_too_large(f"Each ciphertext must be at most {MAX_CIPHERTEXT_BYTES} bytes")
    enforce((ctx.rate_limits.envelopes, principal.user_id))
    recipients = await _check_recipients(ctx, principal, envelopes, complete_for_user_ids)

    created_at = utcnow()  # one timestamp for the whole batch (§5.3)
    expires_at = created_at + timedelta(days=ctx.settings.envelope_ttl_days)
    async with ctx.mailbox_locks.hold(recipients):
        accepted = await _apply_caps(ctx, principal.user_id, envelopes, recipients)
        dropped = list(
            dict.fromkeys(
                envelope.recipient_device_id
                for envelope, ok in zip(envelopes, accepted, strict=True)
                if not ok
            )
        )
        if dropped:
            await _mark_overflow(ctx, dropped, created_at)
        ids: list[str | None] = []
        documents: list[EnvelopeDoc] = []
        for envelope, ok in zip(envelopes, accepted, strict=True):
            if not ok:
                ids.append(None)
                continue
            document = EnvelopeDoc(
                _id=ctx.envelope_ids.next(),
                recipient_device_id=envelope.recipient_device_id,
                recipient_user_id=recipients[envelope.recipient_device_id]["user_id"],
                sender_user_id=principal.user_id,
                sender_device_id=principal.device_id,
                nonce=envelope.nonce,
                ciphertext=envelope.ciphertext,
                size=len(envelope.ciphertext),
                created_at=created_at,
                expires_at=expires_at,
            )
            documents.append(document)
            ids.append(str(document["_id"]))
        if documents:
            await ctx.db.envelopes.insert_many(documents, ordered=True)

    revoked = await _discard_for_revoked(ctx, documents)
    for document in documents:
        device_id = document["recipient_device_id"]
        if device_id not in revoked and ctx.realtime.get(device_id) is not None:
            ctx.realtime.send_to_device(device_id, protocol.envelope(envelope_out(document)))
    if dropped:
        logger.info("mailbox cap reached on %d device(s); envelopes dropped", len(dropped))
    return SendResult(ids=ids, created_at=created_at, dropped_device_ids=dropped)


async def _check_recipients(
    ctx: AppContext,
    principal: Principal,
    envelopes: Sequence[OutgoingEnvelope],
    complete_for_user_ids: Sequence[str],
) -> dict[str, DeviceDoc]:
    """Every rule of §5.3 that can reject the whole batch, most definitive first.

    403s come before 409s: a sender that may not write to someone at all must not learn
    which of that user's device ids are stale or missing.
    """
    me = principal.user_id
    target_ids = list(dict.fromkeys(envelope.recipient_device_id for envelope in envelopes))
    found = await ctx.db.devices.find({"_id": {"$in": target_ids}}).to_list()
    devices = {device["_id"]: device for device in found}
    complete_for = list(dict.fromkeys(complete_for_user_ids))

    other_users = {device["user_id"] for device in found if device["user_id"] != me}
    # complete_for users are checked too: missing_device_ids would otherwise reveal the
    # device ids of anyone whose user id the sender knows.
    if not await _all_friends(ctx, me, other_users | {u for u in complete_for if u != me}):
        raise not_friends()
    if other_users and principal.device["certificate"] is None:
        raise device_not_linked()

    stale = [device_id for device_id in target_ids if not _deliverable(devices.get(device_id), me)]
    missing = await _missing_devices(ctx, principal, complete_for, set(target_ids))
    if stale or missing:
        raise conflict(
            "stale_devices",
            "Some recipient devices are unknown, revoked, not linked or missing",
            details={"stale_device_ids": stale, "missing_device_ids": missing},
        )
    return devices


async def _discard_for_revoked(ctx: AppContext, documents: Sequence[EnvelopeDoc]) -> set[str]:
    """Delete what was just stored for devices revoked since the recipient check.

    Revocation sets ``revoked_at`` before deleting pending envelopes (§5.4), so either its
    deletion saw these documents or this check sees ``revoked_at``: a revoked device never
    keeps envelopes until the TTL.
    """
    if not documents:
        return set()
    device_ids = list({document["recipient_device_id"] for document in documents})
    revoked = {
        str(device_id)
        for device_id in await ctx.db.devices.distinct(
            "_id", {"_id": {"$in": device_ids}, "revoked_at": {"$ne": None}}
        )
    }
    if revoked:
        await ctx.db.envelopes.delete_many(
            {
                "_id": {"$in": [document["_id"] for document in documents]},
                "recipient_device_id": {"$in": sorted(revoked)},
            }
        )
    return revoked


def _deliverable(device: DeviceDoc | None, sender_user_id: str) -> bool:
    if device is None or device["revoked_at"] is not None:
        return False
    # Own devices may be unlinked (that is how a new device receives its link envelope);
    # other users' devices must be certified, as clients only trust those (§8).
    return device["user_id"] == sender_user_id or device["certificate"] is not None


async def _all_friends(ctx: AppContext, user_id: str, others: Collection[str]) -> bool:
    if not others:
        return True
    keys = [pair_key(user_id, other) for other in others]
    return await ctx.db.friendships.count_documents({"_id": {"$in": keys}}) == len(keys)


async def _missing_devices(
    ctx: AppContext, principal: Principal, user_ids: Sequence[str], targeted: Collection[str]
) -> list[str]:
    """Active linked devices of ``user_ids`` the batch skips, except the sending device."""
    if not user_ids:
        return []
    linked = await ctx.db.devices.distinct(
        "_id",
        {"user_id": {"$in": list(user_ids)}, "revoked_at": None, "certificate": {"$ne": None}},
    )
    return sorted(
        str(device_id)
        for device_id in linked
        if device_id != principal.device_id and device_id not in targeted
    )


async def _apply_caps(
    ctx: AppContext,
    sender_user_id: str,
    envelopes: Sequence[OutgoingEnvelope],
    recipients: dict[str, DeviceDoc],
) -> list[bool]:
    """Which envelopes fit the mailbox caps, in batch order. Callers hold the device locks."""
    counts = await _pending_counts(ctx, sender_user_id, list(recipients))
    accepted: list[bool] = []
    for envelope in envelopes:
        device_id = envelope.recipient_device_id
        total, from_sender = counts.setdefault(device_id, [0, 0])
        # The per-sender cap protects a mailbox from one *other* user; a user's own devices
        # (sync copies, history transfer) are bounded by the device cap only.
        foreign = recipients[device_id]["user_id"] != sender_user_id
        ok = total < MAX_PENDING_PER_DEVICE and not (
            foreign and from_sender >= MAX_PENDING_PER_SENDER
        )
        if ok:
            counts[device_id][0] += 1
            counts[device_id][1] += 1
        accepted.append(ok)
    return accepted


async def _pending_counts(
    ctx: AppContext, sender_user_id: str, device_ids: list[str]
) -> dict[str, list[int]]:
    """``{device_id: [pending total, pending from sender_user_id]}`` in one round trip."""
    pipeline: list[dict[str, Any]] = [
        {"$match": {"recipient_device_id": {"$in": device_ids}}},
        {
            "$group": {
                "_id": "$recipient_device_id",
                "total": {"$sum": 1},
                "from_sender": {
                    "$sum": {"$cond": [{"$eq": ["$sender_user_id", sender_user_id]}, 1, 0]}
                },
            }
        },
    ]
    cursor = await ctx.db.envelopes.aggregate(pipeline)
    # The grouped rows are not envelopes, whatever the collection type says.
    rows = cast("list[dict[str, Any]]", await cursor.to_list())
    return {str(row["_id"]): [int(row["total"]), int(row["from_sender"])] for row in rows}


async def _mark_overflow(ctx: AppContext, device_ids: list[str], now: datetime) -> None:
    # Keep the first overflow time if the gap has not been reported yet.
    await ctx.db.devices.update_many(
        {"_id": {"$in": device_ids}, "overflow_at": None}, {"$set": {"overflow_at": now}}
    )


async def take_gap(ctx: AppContext, device_id: str) -> bool:
    """Report and clear the device's overflow flag; atomic, so it is reported exactly once."""
    cleared = await ctx.db.devices.find_one_and_update(
        {"_id": device_id, "overflow_at": {"$ne": None}},
        {"$set": {"overflow_at": None}},
        projection={"_id": True},
    )
    return cleared is not None


async def restore_gap(ctx: AppContext, device_id: str) -> None:
    """Put back a gap that :func:`take_gap` cleared but could not be reported, so the device's
    next socket or ``GET`` reports it instead; a gap set meanwhile is kept as it is."""
    await ctx.db.devices.update_one(
        {"_id": device_id, "overflow_at": None}, {"$set": {"overflow_at": utcnow()}}
    )


async def fetch_pending(
    ctx: AppContext, device_id: str, limit: int
) -> tuple[list[EnvelopeDoc], bool]:
    """Oldest pending envelopes first, plus the one-time gap flag.

    A page ends early once its ciphertext would pass ``MAX_FETCH_BYTES`` (it always holds at
    least one envelope); clients drain until a page comes back empty.
    """
    # The TTL monitor deletes only about once a minute; never hand out an expired envelope.
    cursor = (
        ctx.db.envelopes.find({"recipient_device_id": device_id, "expires_at": {"$gt": utcnow()}})
        .sort([("_id", ASCENDING)])
        .limit(limit)
    )
    envelopes: list[EnvelopeDoc] = []
    total = 0
    try:
        async for envelope in cursor:
            total += envelope["size"]
            if envelopes and total > MAX_FETCH_BYTES:
                break
            envelopes.append(envelope)
    finally:
        await cursor.close()
    # Cleared only after the read succeeded, so a failed request does not lose the gap.
    return envelopes, await take_gap(ctx, device_id)


async def ack_envelopes(ctx: AppContext, device_id: str, ids: Sequence[str]) -> int:
    """Delete the given envelopes if addressed to ``device_id``; other ids are ignored."""
    object_ids = [ObjectId(envelope_id) for envelope_id in dict.fromkeys(ids)]
    result = await ctx.db.envelopes.delete_many(
        {"_id": {"$in": object_ids}, "recipient_device_id": device_id}
    )
    return result.deleted_count
