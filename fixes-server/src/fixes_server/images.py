"""Avatar image pipeline (protocol §5.3 ``PUT /v1/users/me/avatar``). Synchronous: run it in
the worker pool, never on the event loop."""

from __future__ import annotations

import io
import logging
import warnings

from PIL import Image, ImageOps, JpegImagePlugin

logger = logging.getLogger(__name__)

MAX_AVATAR_BYTES = 5 * 1024 * 1024
MAX_SIDE_PX = 8192
MAX_PIXELS = 25_000_000
OUTPUT_SIDE_PX = 512
JPEG_DRAFT_SIZE = (1024, 1024)
JPEG_QUALITY = 85
ALLOWED_FORMATS = ("JPEG", "PNG", "WEBP")
# libjpeg's default progressive script has 10 scans (6 for grayscale) and encoders that
# optimise scans rarely exceed about 20; baseline JPEGs have 1 to 3.
MAX_JPEG_SCANS = 64

Image.MAX_IMAGE_PIXELS = MAX_PIXELS
# Process-wide on purpose: warnings.catch_warnings() is not thread-safe on Python 3.13 and the
# pipeline runs in worker threads. Only Pillow emits this category.
warnings.filterwarnings("error", category=Image.DecompressionBombWarning)


class InvalidImageError(ValueError):
    """The upload is not an acceptable JPEG/PNG/WebP image."""


def check_dimensions(size: tuple[int, int]) -> None:
    """Reject images whose *header* claims too many pixels, before anything is decoded."""
    width, height = size
    if width < 1 or height < 1:
        raise InvalidImageError("image has no pixels")
    if width > MAX_SIDE_PX or height > MAX_SIDE_PX:
        raise InvalidImageError(f"image sides must be at most {MAX_SIDE_PX} px")
    if width * height > MAX_PIXELS:
        raise InvalidImageError(f"image must have at most {MAX_PIXELS} pixels")


def count_jpeg_scans(data: bytes, stop_after: int) -> int:
    """Count the scans (SOS markers) of a JPEG the way libjpeg reads it, up to ``stop_after``.

    Each progressive scan is a pass over the whole image, even at draft scale, and neither
    libjpeg nor Pillow limits how many there are: a few bytes per empty scan let a 5 MiB
    upload occupy a worker thread for minutes. The walk skips every segment by its length
    (an Exif thumbnail is a whole JPEG with its own scans, inside APP1) and steps over
    entropy-coded data, where 0xFF is always followed by a stuffed 0x00 or a restart marker.
    Like libjpeg, it resynchronises on the next marker after any stray bytes.
    """
    scans = 0
    position = 2  # after SOI
    end = len(data)
    while scans <= stop_after:
        position = data.find(b"\xff", position)
        if position < 0 or position + 1 >= end:
            break
        marker = data[position + 1]
        if marker == 0xFF:  # a fill byte; the next 0xFF may start the marker
            position += 1
            continue
        position += 2
        if marker == 0x00:  # a stuffed zero inside entropy-coded data
            continue
        if marker == 0xD9:  # EOI: the decoder stops here
            break
        if 0xD0 <= marker <= 0xD8 or marker == 0x01:  # RSTn, SOI and TEM have no length
            continue
        if marker == 0xDA:
            scans += 1
        if position + 2 > end:
            break
        length = int.from_bytes(data[position : position + 2], "big")
        # A segment length counts its own two bytes; libjpeg skips nothing for shorter ones.
        position += max(length, 2)
    return scans


def check_jpeg_scans(data: bytes) -> None:
    if data.startswith(b"\xff\xd8") and count_jpeg_scans(data, MAX_JPEG_SCANS) > MAX_JPEG_SCANS:
        raise InvalidImageError(f"JPEG images may have at most {MAX_JPEG_SCANS} scans")


def process_avatar(data: bytes) -> bytes:
    """Decode an untrusted upload and re-encode it as a clean ≤512 px JPEG without metadata."""
    check_jpeg_scans(data)
    try:
        with Image.open(io.BytesIO(data), formats=list(ALLOWED_FORMATS)) as image:
            check_dimensions(image.size)
            if isinstance(image, JpegImagePlugin.JpegImageFile):
                # Lets libjpeg decode at a reduced scale: far less memory for large photos.
                image.draft("RGB", JPEG_DRAFT_SIZE)
            image.seek(0)
            upright = ImageOps.exif_transpose(image)
            rgb = upright.convert("RGB")
            rgb.thumbnail((OUTPUT_SIDE_PX, OUTPUT_SIDE_PX))
            output = io.BytesIO()
            # No exif=/icc_profile= arguments: Pillow then writes neither.
            rgb.save(output, format="JPEG", quality=JPEG_QUALITY)
            return output.getvalue()
    except InvalidImageError:
        raise
    except Exception as exc:
        # Decoder boundary for untrusted bytes. Pillow's plugins raise many unrelated types
        # (OSError, SyntaxError, struct.error, DecompressionBomb*, ...); every one of them
        # means "not an acceptable image".
        logger.info("avatar rejected: %s", type(exc).__name__)
        raise InvalidImageError("could not decode image") from exc
