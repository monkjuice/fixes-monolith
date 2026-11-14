"""Integration points between the REST device lifecycle and the realtime layer.

Revocation and identity changes happen in REST handlers, but their side effects reach other
parts of the server:

* ``delete_pending_envelopes`` - remove envelopes addressed to revoked devices (§5.4 step 3);
* ``close_device_sockets`` - close those devices' sockets with code 4401 (§5.4 step 4);
* ``notify_devices_changed`` - push ``{"type":"devices_changed"}`` to a user's sockets
  (login, certificate, identity, reset-identity and revocation, §5.3/§5.4).

The real implementation is :class:`fixes_server.realtime.hooks.RealtimeHooks`, installed by
:func:`fixes_server.context.build_context`. Extra observers (tests use one that records every
call) are chained after it with :class:`ChainedHooks`.

Callers already invoke the hooks in the order §5.4 requires; implementations must be
idempotent because revocation can be retried after a crash.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence


class DeviceEventHooks:
    """No-op base class; subclasses override what they care about."""

    async def delete_pending_envelopes(self, device_ids: Sequence[str]) -> None:
        """Delete every pending envelope whose ``recipient_device_id`` is in the list."""
        return None

    async def close_device_sockets(self, device_ids: Sequence[str]) -> None:
        """Close the live WebSocket of each device with close code 4401."""
        return None

    async def notify_devices_changed(
        self, user_id: str, *, exclude_device_ids: Collection[str] = ()
    ) -> None:
        """Send ``devices_changed`` to the user's sockets except the excluded devices."""
        return None


class ChainedHooks(DeviceEventHooks):
    """Calls several hook implementations in order, so observers never replace the real one."""

    def __init__(self, *hooks: DeviceEventHooks) -> None:
        self._hooks = hooks

    async def delete_pending_envelopes(self, device_ids: Sequence[str]) -> None:
        for hook in self._hooks:
            await hook.delete_pending_envelopes(device_ids)

    async def close_device_sockets(self, device_ids: Sequence[str]) -> None:
        for hook in self._hooks:
            await hook.close_device_sockets(device_ids)

    async def notify_devices_changed(
        self, user_id: str, *, exclude_device_ids: Collection[str] = ()
    ) -> None:
        for hook in self._hooks:
            await hook.notify_devices_changed(user_id, exclude_device_ids=exclude_device_ids)
