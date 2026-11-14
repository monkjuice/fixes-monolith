"""Static checks of docker-compose.yml (no Docker daemon is needed or used)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

COMPOSE = Path(__file__).resolve().parents[1] / "docker-compose.yml"


def _compose() -> dict[str, Any]:
    loaded: dict[str, Any] = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    return loaded


def _networks(service: dict[str, Any]) -> set[str]:
    return set(service.get("networks") or ())


def test_avatars_are_readable_but_the_bucket_is_not_listable() -> None:
    """mc's canned "download" policy on a prefix also allows anonymous ListBucket on it, so
    anyone could enumerate every avatar object; the policy grants s3:GetObject only."""
    command = " ".join(_compose()["services"]["minio-init"]["command"])
    assert "anonymous set download" not in command
    assert "mc anonymous set-json" in command
    match = re.search(r"printf '(\{.*\})'", command)
    assert match is not None, command
    policy = json.loads(match[1].replace("%s", "bucket"))
    assert policy["Statement"] == [
        {
            "Effect": "Allow",
            "Principal": {"AWS": ["*"]},
            "Action": ["s3:GetObject"],
            "Resource": ["arn:aws:s3:::bucket/avatars/*"],
        }
    ]


def test_mongodb_is_reachable_from_the_api_only() -> None:
    compose = _compose()
    services = compose["services"]
    mongo_networks = _networks(services["mongo"])
    assert mongo_networks
    for name in mongo_networks:
        assert compose["networks"][name].get("internal") is True, name
    assert mongo_networks <= _networks(services["api"])
    for name, service in services.items():
        if name not in {"mongo", "api"}:
            assert not mongo_networks & _networks(service), name


def test_api_container_is_hardened() -> None:
    api = _compose()["services"]["api"]
    assert api["read_only"] is True
    # Starlette spools multipart uploads over 1 MiB (avatars) to a temporary file.
    assert "/tmp" in api["tmpfs"]  # noqa: S108
    assert api["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in api["security_opt"]
