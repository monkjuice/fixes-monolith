---
title: Progressive-JPEG scan bombs
type: gotcha
summary: "A valid ≤ 5 MiB progressive JPEG with ~100 000 scans keeps Pillow busy for minutes (each scan is a full pass; libjpeg sets no limit), so the avatar pipeline counts SOS markers and refuses more than 64 before decoding."
tags: [v2, server, images, pillow, dos, security, gotcha]
sources: []
updated: 2026-11-13
---

# Progressive-JPEG scan bombs

Found in the `fixes-server/` code review (2026-11), now fixed.

## Pitfall

The §5.3 avatar guards (size limit, header dimensions, `MAX_IMAGE_PIXELS`, decompression-bomb warning as error) do not
catch it: a small-dimension JPEG within the 5 MiB upload limit can hold ~100 000 nearly empty progressive scans of a
few bytes each. Every scan is a pass over the whole image, even at `draft()` scale, and neither libjpeg nor Pillow
limits their number, so one upload keeps a worker thread busy for minutes. The pool (`CapacityLimiter(4)`) is shared
with argon2, so a few such uploads also stall logins.

## Fix (as of 2026-11-13)

`fixes-server/src/fixes_server/images.py` counts SOS markers the way libjpeg reads the file (stepping over embedded
Exif thumbnails) and rejects JPEGs with more than `MAX_JPEG_SCANS = 64` as 400 `invalid_image` before decoding. Normal
files have 1–3 scans (baseline) or about 10 (libjpeg progressive), rarely over 20. `tests/helpers.py`
`scan_heavy_jpeg` builds a test file.

Related: [fixes-server](fixes-server.md), [v2 architecture](v2-architecture.md).
