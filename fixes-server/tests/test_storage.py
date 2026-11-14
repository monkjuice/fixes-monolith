from __future__ import annotations

from pathlib import Path
from typing import Any

import anyio
import pytest

from fixes_server.blocking import create_limiter
from fixes_server.storage import LocalAvatarStorage, S3AvatarStorage, new_avatar_key


def test_local_storage_roundtrip(tmp_path: Path) -> None:
    async def scenario() -> None:
        storage = LocalAvatarStorage(tmp_path, "https://api.example.org", create_limiter())
        storage.prepare()
        key = new_avatar_key()
        await storage.put_avatar(key, b"jpeg-bytes")
        path = tmp_path / "avatars" / f"{key}.jpg"
        assert path.read_bytes() == b"jpeg-bytes"
        assert not list((tmp_path / "avatars").glob("*.tmp"))
        assert storage.avatar_url(key) == f"https://api.example.org/media/avatars/{key}.jpg"
        await storage.delete_avatar(key)
        assert not path.exists()
        await storage.delete_avatar(key)  # Deleting twice is fine.

    anyio.run(scenario)


@pytest.mark.parametrize("key", ["../../etc/passwd", "ABCDEF" * 6, "a" * 31, ""])
def test_keys_are_validated(tmp_path: Path, key: str) -> None:
    storage = LocalAvatarStorage(tmp_path, "https://api.example.org", create_limiter())
    with pytest.raises(ValueError, match="avatar key"):
        storage.avatar_url(key)


class FakeS3Client:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.closed = False

    def put_object(self, **kwargs: Any) -> None:
        self.calls.append(("put_object", kwargs))

    def delete_object(self, **kwargs: Any) -> None:
        self.calls.append(("delete_object", kwargs))

    def close(self) -> None:
        self.closed = True


def test_s3_storage_uses_public_urls_and_object_keys() -> None:
    async def scenario() -> None:
        client = FakeS3Client()
        storage = S3AvatarStorage(
            client, "fixes-avatars", "https://cdn.example.org", create_limiter()
        )
        key = new_avatar_key()
        assert storage.avatar_url(key) == f"https://cdn.example.org/avatars/{key}.jpg"
        await storage.put_avatar(key, b"jpeg")
        await storage.delete_avatar(key)
        await storage.aclose()
        put, delete = client.calls
        assert put == (
            "put_object",
            {
                "Bucket": "fixes-avatars",
                "Key": f"avatars/{key}.jpg",
                "Body": b"jpeg",
                "ContentType": "image/jpeg",
                "CacheControl": "public, max-age=31536000, immutable",
            },
        )
        assert delete == ("delete_object", {"Bucket": "fixes-avatars", "Key": f"avatars/{key}.jpg"})
        assert client.closed

    anyio.run(scenario)
