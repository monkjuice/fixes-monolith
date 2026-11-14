"""Unit tests for the avatar pipeline: header checks happen before any decoding."""

from __future__ import annotations

import io
import struct
import zlib

import pytest
from PIL import Image, ImageFile, ImageOps

from fixes_server.images import InvalidImageError, check_dimensions, process_avatar
from tests.helpers import image_bytes, jpeg_segment, scan_heavy_jpeg


def _png_header_only(width: int, height: int) -> bytes:
    """A PNG whose header claims ``width`` x ``height`` but whose pixel data is garbage."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", b"garbage")
        + chunk(b"IEND", b"")
    )


@pytest.mark.parametrize("size", [(8193, 1), (1, 8193), (5001, 5001), (0, 10), (10, 0)])
def test_check_dimensions_rejects(size: tuple[int, int]) -> None:
    with pytest.raises(InvalidImageError):
        check_dimensions(size)


@pytest.mark.parametrize("size", [(8192, 1), (5000, 5000), (1, 1)])
def test_check_dimensions_accepts(size: tuple[int, int]) -> None:
    check_dimensions(size)


class DecodeAttemptedError(BaseException):
    """BaseException so the pipeline's ``except Exception`` cannot turn it into a rejection."""


@pytest.mark.parametrize("size", [(8193, 100), (100, 8193), (6000, 6000), (100_000, 100_000)])
def test_oversize_headers_rejected_before_decoding(
    monkeypatch: pytest.MonkeyPatch, size: tuple[int, int]
) -> None:
    def no_decoding(*_: object, **__: object) -> None:
        raise DecodeAttemptedError

    for cls in (Image.Image, ImageFile.ImageFile):
        monkeypatch.setattr(cls, "load", no_decoding)
    monkeypatch.setattr(ImageOps, "exif_transpose", no_decoding)
    with pytest.raises(InvalidImageError):
        process_avatar(_png_header_only(*size))


def test_output_is_clean_jpeg() -> None:
    exif = Image.Exif()
    exif[0x010F] = "SecretCam"
    data = image_bytes("JPEG", (2000, 1000), exif=exif.tobytes())
    out = process_avatar(data)
    image = Image.open(io.BytesIO(out))
    assert image.format == "JPEG"
    assert image.size == (512, 256)
    assert not image.getexif()
    assert b"SecretCam" not in out


def test_rgba_and_palette_images_are_converted() -> None:
    rgba = io.BytesIO()
    Image.new("RGBA", (40, 40), (0, 0, 255, 128)).save(rgba, format="PNG")
    palette = io.BytesIO()
    Image.new("P", (40, 40)).save(palette, format="PNG")
    for data in (rgba.getvalue(), palette.getvalue()):
        assert Image.open(io.BytesIO(process_avatar(data))).mode == "RGB"


def test_animated_webp_uses_first_frame() -> None:
    frames = [Image.new("RGB", (32, 32), color) for color in ("red", "blue")]
    output = io.BytesIO()
    frames[0].save(output, format="WEBP", save_all=True, append_images=frames[1:], lossless=True)
    result = Image.open(io.BytesIO(process_avatar(output.getvalue()))).convert("RGB")
    red, green, blue = result.getpixel((16, 16))  # type: ignore[misc]
    assert red > 200
    assert blue < 60
    assert green < 60


@pytest.mark.parametrize(
    "data", [b"", b"GIF89a", image_bytes("GIF", (4, 4)), image_bytes("TIFF", (4, 4))]
)
def test_other_formats_rejected(data: bytes) -> None:
    with pytest.raises(InvalidImageError):
        process_avatar(data)


def test_progressive_jpeg_with_a_few_scans_is_accepted() -> None:
    image = Image.open(io.BytesIO(process_avatar(scan_heavy_jpeg(64, 48, 8))))
    assert image.size == (64, 48)


def test_jpeg_with_too_many_scans_is_rejected_before_decoding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pillow and libjpeg set no limit on progressive scans, and each scan is a full pass
    over the image: a 5 MiB upload of empty scans could keep a worker busy for minutes."""
    data = scan_heavy_jpeg(64, 48, 200)

    def no_decoding(*_: object, **__: object) -> None:
        raise DecodeAttemptedError

    monkeypatch.setattr(Image, "open", no_decoding)
    with pytest.raises(InvalidImageError, match="scans"):
        process_avatar(data)


def _with_exif_thumbnail(jpeg: bytes, thumbnail: bytes) -> bytes:
    """Insert an APP1 Exif segment whose IFD1 holds a complete JPEG thumbnail, as cameras do."""
    ifd1_offset = 8 + 6  # TIFF header, then an empty IFD0 (entry count + next-IFD offset)
    thumbnail_offset = ifd1_offset + 2 + 2 * 12 + 4
    tiff = (
        b"II*\x00"
        + struct.pack("<I", 8)
        + struct.pack("<HI", 0, ifd1_offset)
        + struct.pack("<H", 2)
        + struct.pack("<HHII", 0x0201, 4, 1, thumbnail_offset)  # JPEGInterchangeFormat
        + struct.pack("<HHII", 0x0202, 4, 1, len(thumbnail))  # JPEGInterchangeFormatLength
        + struct.pack("<I", 0)
        + thumbnail
    )
    return jpeg[:2] + jpeg_segment(0xFFE1, b"Exif\x00\x00" + tiff) + jpeg[2:]


def test_scans_inside_metadata_segments_do_not_count() -> None:
    """Only the image's own scans count: an Exif thumbnail is a whole JPEG with its own scan
    markers, and comment or APPn payloads are skipped by the decoder (and by the count)."""
    photo = image_bytes("JPEG", (640, 480), progressive=True)
    thumbnail = image_bytes("JPEG", (160, 120), progressive=True)
    data = _with_exif_thumbnail(photo, thumbnail)
    data = data[:2] + jpeg_segment(0xFFFE, b"\xff\xda" * 100) + data[2:]
    assert data.count(b"\xff\xda") > 100
    image = Image.open(io.BytesIO(process_avatar(data)))
    assert image.size == (512, 384)
