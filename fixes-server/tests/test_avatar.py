from __future__ import annotations

import io
import re
from pathlib import Path

import pytest
from PIL import Image
from starlette.testclient import TestClient

from fixes_server.config import Settings
from fixes_server.images import MAX_AVATAR_BYTES
from tests.conftest import MakeClient
from tests.helpers import Device, assert_error, image_bytes, linked_user, scan_heavy_jpeg

AVATAR_URL = re.compile(r"^http://testserver/media/avatars/([0-9a-f]{32})\.jpg$")


def _upload(
    client: TestClient, device: Device, data: bytes, name: str = "a.png", mime: str = "image/png"
):  # type: ignore[no-untyped-def]
    return client.put(
        "/v1/users/me/avatar", files={"image": (name, data, mime)}, headers=device.headers
    )


def _fetch(client: TestClient, url: str) -> Image.Image:
    response = client.get(url)
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    image = Image.open(io.BytesIO(response.content))
    image.load()
    return image


def test_png_upload(client: TestClient, settings: Settings) -> None:
    account, device = linked_user(client)
    response = _upload(client, device, image_bytes("PNG", (1600, 800)))
    assert response.status_code == 200, response.text
    me = response.json()["user"]
    assert me["id"] == account.id
    assert me["identity_key"] == account.identity_key
    match = AVATAR_URL.match(me["avatar_url"])
    assert match is not None
    assert (settings.storage_local_dir / "avatars" / f"{match[1]}.jpg").is_file()

    image = _fetch(client, me["avatar_url"])
    assert image.format == "JPEG"
    assert image.size == (512, 256)
    # Every view of the user carries the absolute URL.
    assert (
        client.get("/v1/users/me", headers=device.headers).json()["avatar_url"] == me["avatar_url"]
    )
    assert (
        client.get(f"/v1/users/{account.id}", headers=device.headers).json()["avatar_url"]
        == me["avatar_url"]
    )


def test_jpeg_exif_is_applied_and_stripped(client: TestClient) -> None:
    _, device = linked_user(client)
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation: rotate 90° clockwise to display.
    exif[0x010F] = "SecretCam"  # Make
    exif[0x0131] = "tracking-software"  # Software
    original = image_bytes("JPEG", (1200, 600), exif=exif.tobytes(), quality=90)
    assert b"SecretCam" in original

    response = _upload(client, device, original, "photo.jpg", "image/jpeg")
    assert response.status_code == 200, response.text
    url = response.json()["user"]["avatar_url"]
    raw = client.get(url).content
    assert b"SecretCam" not in raw
    assert b"Exif" not in raw
    image = _fetch(client, url)
    assert image.size == (256, 512)  # Transposed by the orientation, then thumbnailed.
    assert not image.getexif()
    assert "icc_profile" not in image.info


def test_webp_and_small_images_are_not_upscaled(client: TestClient) -> None:
    _, device = linked_user(client)
    response = _upload(client, device, image_bytes("WEBP", (100, 40)), "a.webp", "image/webp")
    assert response.status_code == 200, response.text
    assert _fetch(client, response.json()["user"]["avatar_url"]).size == (100, 40)


def test_replacing_deletes_old_object(client: TestClient, settings: Settings) -> None:
    _, device = linked_user(client)
    first = _upload(client, device, image_bytes("PNG", (64, 64))).json()["user"]["avatar_url"]
    second = _upload(client, device, image_bytes("PNG", (64, 64), color="blue")).json()["user"][
        "avatar_url"
    ]
    assert first != second
    directory: Path = settings.storage_local_dir / "avatars"
    assert sorted(p.name for p in directory.iterdir()) == [AVATAR_URL.match(second)[1] + ".jpg"]  # type: ignore[index]
    assert_error(client.get(first), 404, "not_found")


def test_image_over_5_mib_is_413(client: TestClient) -> None:
    _, device = linked_user(client)
    # Under the 5.5 MiB request limit, so only the endpoint's own count can reject it.
    response = _upload(client, device, b"\x89PNG" + b"\0" * MAX_AVATAR_BYTES)
    assert_error(response, 413, "payload_too_large")


@pytest.mark.parametrize(
    ("data", "name", "mime"),
    [
        (b"definitely not an image", "a.png", "image/png"),
        (image_bytes("GIF", (10, 10)), "a.gif", "image/gif"),
        (image_bytes("BMP", (10, 10)), "a.bmp", "image/bmp"),
        (image_bytes("PNG", (64, 64))[:60], "truncated.png", "image/png"),
        (b"", "empty.png", "image/png"),
    ],
)
def test_not_an_acceptable_image(client: TestClient, data: bytes, name: str, mime: str) -> None:
    _, device = linked_user(client)
    assert_error(_upload(client, device, data, name, mime), 400, "invalid_image")


def test_oversize_dimensions_rejected(client: TestClient) -> None:
    _, device = linked_user(client)
    too_wide = image_bytes("PNG", (8193, 1))
    assert_error(_upload(client, device, too_wide), 400, "invalid_image")


def test_jpeg_with_too_many_scans_rejected(client: TestClient) -> None:
    _, device = linked_user(client)
    bomb = scan_heavy_jpeg(1024, 1024, 2000)
    assert_error(_upload(client, device, bomb, "a.jpg", "image/jpeg"), 400, "invalid_image")


def test_missing_image_field(client: TestClient) -> None:
    _, device = linked_user(client)
    response = client.put(
        "/v1/users/me/avatar",
        files={"picture": ("a.png", b"x", "image/png")},
        headers=device.headers,
    )
    assert "image" in assert_error(response, 422, "validation_error")["fields"]


def test_avatar_requires_auth(client: TestClient) -> None:
    response = client.put("/v1/users/me/avatar", files={"image": ("a.png", b"x", "image/png")})
    assert_error(response, 401, "unauthorized")


def test_avatar_rate_limit(make_client: MakeClient) -> None:
    with make_client(rate_limit_avatar="1/3600") as client:
        _, device = linked_user(client)
        assert _upload(client, device, image_bytes("PNG", (8, 8))).status_code == 200
        assert_error(_upload(client, device, image_bytes("PNG", (8, 8))), 429, "rate_limited")
