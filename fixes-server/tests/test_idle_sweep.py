"""The idle-device sweep (protocol §5.4): at startup, hourly, and its revocation effects."""

from __future__ import annotations

import functools
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import anyio
import pytest
from pymongo import MongoClient
from pymongo.database import Database
from starlette.testclient import TestClient

from fixes_server.services import idle_sweep
from tests.conftest import MakeClient, MakeSettings
from tests.helpers import (
    RecordingHooks,
    app_context,
    assert_error,
    fetch,
    linked_user,
    live_socket,
    login,
    outgoing,
    register,
    send_ok,
)


def sweep(client: TestClient, **kwargs: Any) -> int:
    # The sweep needs the app's event loop (its MongoDB client lives there).
    ctx = app_context(client)
    revoked: int = client.portal.call(
        functools.partial(idle_sweep.sweep_idle_devices, ctx, **kwargs)
    )
    return revoked


def days_ago(days: float) -> datetime:
    return datetime.now(UTC) - timedelta(days=days)


def test_sweep_revokes_idle_devices(
    client: TestClient, db: Database[dict[str, Any]], hooks: RecordingHooks
) -> None:
    account, active = linked_user(client)
    idle = login(client, account, name="Old phone")
    send_ok(client, active, [outgoing(idle.id)])
    other_user, other_device = linked_user(client)

    with live_socket(client, active) as active_socket, live_socket(client, idle) as idle_socket:
        # Socket auth just refreshed last_seen_at; age the device afterwards.
        db.devices.update_one({"_id": idle.id}, {"$set": {"last_seen_at": days_ago(31)}})
        db.devices.update_one({"_id": other_device.id}, {"$set": {"last_seen_at": days_ago(29)}})
        hooks.events.clear()

        assert sweep(client) == 1

        assert idle_socket.expect_close() == 4401
        assert active_socket.receive() == {"type": "devices_changed"}
        active_socket.sync()

    assert hooks.events == [
        ("delete_pending_envelopes", (idle.id,)),
        ("close_device_sockets", (idle.id,)),
        ("devices_changed", account.id, (idle.id,)),
    ]
    stored = db.devices.find_one({"_id": idle.id})
    assert stored is not None
    assert stored["revoked_at"] is not None
    assert db.refresh_tokens.count_documents({"device_id": idle.id}) == 0
    assert db.envelopes.count_documents({"recipient_device_id": idle.id}) == 0
    assert_error(client.get("/v1/users/me", headers=idle.headers), 401, "device_revoked")

    # Devices seen within the idle window keep working; a second sweep has nothing to do.
    assert client.get("/v1/users/me", headers=active.headers).status_code == 200
    assert client.get("/v1/users/me", headers=other_device.headers).status_code == 200
    assert sweep(client) == 0
    assert other_user.id != account.id


def test_idle_days_setting(
    make_client: MakeClient, mongo_client: MongoClient[dict[str, Any]]
) -> None:
    with make_client(device_idle_days=2) as client:
        account = register(client)
        stale, fresh = login(client, account), login(client, account)
        database = mongo_client[app_context(client).settings.mongodb_db]
        database.devices.update_one({"_id": stale.id}, {"$set": {"last_seen_at": days_ago(3)}})
        database.devices.update_one({"_id": fresh.id}, {"$set": {"last_seen_at": days_ago(1)}})
        assert sweep(client) == 1
        assert_error(client.get("/v1/devices", headers=stale.headers), 401, "device_revoked")
        assert client.get("/v1/devices", headers=fresh.headers).status_code == 200
        # The cutoff is relative to the sweep's clock.
        assert sweep(client, now=datetime.now(UTC) + timedelta(days=2)) == 1


def test_sweep_runs_at_startup(
    make_settings: MakeSettings,
    make_client: MakeClient,
    mongo_client: MongoClient[dict[str, Any]],
) -> None:
    settings = make_settings()
    database = mongo_client[settings.mongodb_db]
    with make_client(settings) as client:
        account = register(client)
        device = login(client, account)
    database.devices.update_one({"_id": device.id}, {"$set": {"last_seen_at": days_ago(45)}})

    with make_client(settings) as client:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            stored = database.devices.find_one({"_id": device.id})
            if stored is not None and stored["revoked_at"] is not None:
                break
            time.sleep(0.05)
        else:
            pytest.fail("the startup sweep did not revoke the idle device")
        assert_error(client.get("/v1/users/me", headers=device.headers), 401, "device_revoked")


def test_sweeper_keeps_running_after_a_failure(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    calls = 0

    async def flaky(ctx: Any, **kwargs: Any) -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("database hiccup")
        return 0

    monkeypatch.setattr(idle_sweep, "sweep_idle_devices", flaky)
    ctx = app_context(client)

    async def run_briefly() -> None:
        with anyio.move_on_after(1.0):
            await idle_sweep.run_idle_sweeper(ctx, interval_seconds=0.05)

    client.portal.call(run_briefly)
    assert calls >= 3
    assert "idle device sweep failed" in caplog.text


def test_pending_envelopes_of_idle_devices_are_not_served(
    client: TestClient, db: Database[dict[str, Any]]
) -> None:
    account, active = linked_user(client)
    idle = login(client, account)
    send_ok(client, active, [outgoing(idle.id)])
    db.devices.update_one({"_id": idle.id}, {"$set": {"last_seen_at": days_ago(60)}})
    assert sweep(client) == 1
    assert fetch(client, active)["envelopes"] == []
    assert db.envelopes.count_documents({}) == 0


def test_next_sweep_finishes_an_interrupted_revocation(
    client: TestClient,
    db: Database[dict[str, Any]],
    hooks: RecordingHooks,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A sweep that failed after setting revoked_at must not leave the device's ciphertext
    behind until the TTL: later sweeps no longer see the device as idle, so they finish
    revocations that left pending envelopes instead (§5.4, §15)."""
    account, active = linked_user(client)
    idle = login(client, account)
    send_ok(client, active, [outgoing(idle.id)])
    db.devices.update_one({"_id": idle.id}, {"$set": {"last_seen_at": days_ago(60)}})
    ctx = app_context(client)

    async def failing(device_ids: Any) -> None:
        raise RuntimeError("database hiccup")

    monkeypatch.setattr(ctx.hooks, "delete_pending_envelopes", failing)
    with pytest.raises(RuntimeError):
        sweep(client)
    monkeypatch.undo()
    stored = db.devices.find_one({"_id": idle.id})
    assert stored is not None
    revoked_at = stored["revoked_at"]
    assert revoked_at is not None
    assert db.envelopes.count_documents({"recipient_device_id": idle.id}) == 1
    hooks.events.clear()

    assert sweep(client) == 0  # nothing newly idle
    assert db.envelopes.count_documents({"recipient_device_id": idle.id}) == 0
    assert hooks.events == [
        ("delete_pending_envelopes", (idle.id,)),
        ("close_device_sockets", (idle.id,)),
        ("devices_changed", account.id, (idle.id,)),
    ]
    stored = db.devices.find_one({"_id": idle.id})
    assert stored is not None
    assert stored["revoked_at"] == revoked_at
    # Finished revocations are not repeated.
    hooks.events.clear()
    assert sweep(client) == 0
    assert hooks.events == []
