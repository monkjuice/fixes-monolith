"""Avatar object storage: local filesystem (served at ``/media``) or any S3-compatible API.

Blocking calls (file I/O, boto3) run in the shared worker pool. URLs are absolute (§5.2).
"""

from __future__ import annotations

import functools
import os
import re
import secrets
import tempfile
from pathlib import Path
from typing import Any, Protocol

import anyio

from fixes_server.blocking import run_blocking
from fixes_server.config import Settings

_KEY_RE = re.compile(r"[0-9a-f]{32}")
_CACHE_CONTROL = "public, max-age=31536000, immutable"
MEDIA_MOUNT_PATH = "/media"


def new_avatar_key() -> str:
    """Random, unguessable object key; a new one per upload so caches never serve stale data."""
    return secrets.token_hex(16)


def _checked_key(key: str) -> str:
    # Keys only ever come from new_avatar_key(); checking keeps a corrupted DB value from
    # turning into a path traversal or an arbitrary bucket key.
    if not _KEY_RE.fullmatch(key):
        raise ValueError("invalid avatar key")
    return key


class AvatarStorage(Protocol):
    def avatar_url(self, key: str) -> str: ...

    async def put_avatar(self, key: str, jpeg: bytes) -> None: ...

    async def delete_avatar(self, key: str) -> None: ...

    async def aclose(self) -> None: ...


class LocalAvatarStorage:
    def __init__(self, root: Path, public_base_url: str, limiter: anyio.CapacityLimiter) -> None:
        self.root = root
        self.directory = root / "avatars"
        self._public_base_url = public_base_url
        self._limiter = limiter

    def prepare(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)

    def avatar_url(self, key: str) -> str:
        return f"{self._public_base_url}{MEDIA_MOUNT_PATH}/avatars/{_checked_key(key)}.jpg"

    async def put_avatar(self, key: str, jpeg: bytes) -> None:
        await run_blocking(self._limiter, self._write, self._path(key), jpeg)

    async def delete_avatar(self, key: str) -> None:
        await run_blocking(
            self._limiter, functools.partial(self._path(key).unlink, missing_ok=True)
        )

    async def aclose(self) -> None:
        return None

    def _path(self, key: str) -> Path:
        return self.directory / f"{_checked_key(key)}.jpg"

    def _write(self, path: Path, data: bytes) -> None:
        # Write-then-rename so the static file server never sees a half-written file.
        fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.replace(tmp_name, path)
        except BaseException:
            Path(tmp_name).unlink(missing_ok=True)
            raise


class S3AvatarStorage:
    """Objects at ``avatars/<key>.jpg`` in a bucket that is public-read or behind a CDN."""

    def __init__(
        self, client: Any, bucket: str, public_base_url: str, limiter: anyio.CapacityLimiter
    ) -> None:
        self._client = client
        self._bucket = bucket
        self._public_base_url = public_base_url
        self._limiter = limiter

    def avatar_url(self, key: str) -> str:
        return f"{self._public_base_url}/{self._object_key(key)}"

    async def put_avatar(self, key: str, jpeg: bytes) -> None:
        await run_blocking(self._limiter, self._put, self._object_key(key), jpeg)

    async def delete_avatar(self, key: str) -> None:
        await run_blocking(self._limiter, self._delete, self._object_key(key))

    async def aclose(self) -> None:
        await run_blocking(self._limiter, self._client.close)

    @staticmethod
    def _object_key(key: str) -> str:
        return f"avatars/{_checked_key(key)}.jpg"

    def _put(self, object_key: str, data: bytes) -> None:
        self._client.put_object(
            Bucket=self._bucket,
            Key=object_key,
            Body=data,
            ContentType="image/jpeg",
            CacheControl=_CACHE_CONTROL,
        )

    def _delete(self, object_key: str) -> None:
        self._client.delete_object(Bucket=self._bucket, Key=object_key)


def _create_s3_client(settings: Settings) -> Any:
    # Imported lazily: boto3 is slow to import and unused with the local backend. Credentials
    # come from boto3's standard chain (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, profiles,
    # instance roles), so no secret passes through Fixes settings.
    import boto3

    return boto3.client("s3", endpoint_url=settings.s3_endpoint_url, region_name=settings.s3_region)


async def create_storage(settings: Settings, limiter: anyio.CapacityLimiter) -> AvatarStorage:
    if settings.storage_backend == "s3":
        if settings.s3_bucket is None or settings.s3_public_base_url is None:
            raise RuntimeError("S3 storage requires a bucket and a public base URL")
        client = await run_blocking(limiter, _create_s3_client, settings)
        return S3AvatarStorage(client, settings.s3_bucket, settings.s3_public_base_url, limiter)
    storage = LocalAvatarStorage(settings.storage_local_dir, settings.public_base_url, limiter)
    await run_blocking(limiter, storage.prepare)
    return storage
