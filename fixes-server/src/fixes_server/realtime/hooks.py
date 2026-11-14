"""The real device lifecycle hooks: envelope cleanup, socket closing and notifications (§5.4)."""

from __future__ import annotations

import logging
from collections.abc import Collection, Sequence

from pymongo.asynchronous.collection import AsyncCollection

from fixes_server.documents import EnvelopeDoc
from fixes_server.hooks import DeviceEventHooks
from fixes_server.realtime.connections import ConnectionManager
from fixes_server.realtime.protocol import CLOSE_UNAUTHORIZED, DEVICES_CHANGED

logger = logging.getLogger(__name__)


class RealtimeHooks(DeviceEventHooks):
    def __init__(
        self, envelopes: AsyncCollection[EnvelopeDoc], connections: ConnectionManager
    ) -> None:
        self._envelopes = envelopes
        self._connections = connections

    async def delete_pending_envelopes(self, device_ids: Sequence[str]) -> None:
        if not device_ids:
            return
        result = await self._envelopes.delete_many(
            {"recipient_device_id": {"$in": list(device_ids)}}
        )
        if result.deleted_count:
            logger.info("deleted %d pending envelope(s) of revoked devices", result.deleted_count)

    async def close_device_sockets(self, device_ids: Sequence[str]) -> None:
        # Closing only cancels the socket's tasks; it never waits on a slow client, so the
        # revoking request is not held up. The order of §5.4 holds for what clients observe.
        self._connections.close_devices(device_ids, CLOSE_UNAUTHORIZED, "device revoked")

    async def notify_devices_changed(
        self, user_id: str, *, exclude_device_ids: Collection[str] = ()
    ) -> None:
        self._connections.send_to_user(user_id, DEVICES_CHANGED, exclude=exclude_device_ids)
