"""Generate small Photoshop and TIFF-based Digital Negative QA images."""

from io import BytesIO
from pathlib import Path
from struct import pack

from PIL import Image


WIDTH, HEIGHT = 96, 64
LEFT, RIGHT = (216, 92, 36), (40, 113, 191)
ROOT = Path(__file__).parent


def scene():
    image = Image.new("RGB", (WIDTH, HEIGHT), LEFT)
    image.paste(RIGHT, (WIDTH // 2, 0, WIDTH, HEIGHT))
    return image


def photoshop(image):
    planes = image.split()
    rows = [
        bytes([257 - WIDTH // 2, plane.getpixel((0, y)), 257 - WIDTH // 2, plane.getpixel((WIDTH - 1, y))])
        for plane in planes
        for y in range(HEIGHT)
    ]
    header = pack(">4sH6xHIIHH", b"8BPS", 1, len(planes), HEIGHT, WIDTH, 8, 3)
    rle = pack(">H", 1) + b"".join(pack(">H", len(row)) for row in rows) + b"".join(rows)
    return header + pack(">III", 0, 0, 0) + rle


def tiff_field(tag, kind, count, value):
    if kind == 3:
        value = pack("<H", value) if count == 1 else pack("<" + "H" * count, *value)
    elif kind == 4:
        value = pack("<I", value)
    return pack("<HHI", tag, kind, count) + value.ljust(4, b"\0")


def dng(image, with_preview=True):
    jpeg = BytesIO()
    image.save(jpeg, format="JPEG", quality=96, subsampling=0)
    preview = jpeg.getvalue() if with_preview else b""
    ifd_offset = 8
    camera = b"TaOffice QA\0"
    cfa = bytes((0, 1, 1, 2))
    tags = [
        (256, 4, 1, WIDTH), (257, 4, 1, HEIGHT), (258, 3, 1, 8),
        (259, 3, 1, 1), (262, 3, 1, 32803), (273, 4, 1, 0),
        (274, 3, 1, 1), (277, 3, 1, 1), (278, 4, 1, HEIGHT),
        (279, 4, 1, WIDTH * HEIGHT), (284, 3, 1, 1),
        (33421, 3, 2, (2, 2)), (33422, 1, 4, cfa),
        (50706, 1, 4, bytes((1, 4, 0, 0))), (50707, 1, 4, bytes((1, 1, 0, 0))),
        (50708, 2, len(camera), b""),
        (50710, 1, 3, bytes((0, 1, 2))), (50711, 3, 1, 1),
    ]
    sensor = bytes(
        image.getpixel((x, y))[cfa[(y % 2) * 2 + (x % 2)]]
        for y in range(HEIGHT)
        for x in range(WIDTH)
    )
    camera_offset = ifd_offset + 2 + len(tags) * 12 + 4
    sensor_offset = camera_offset + len(camera)
    tags = [(tag, kind, count, pack("<I", camera_offset) if tag == 50708 else
             sensor_offset if tag == 273 else value) for tag, kind, count, value in tags]
    preview_ifd = sensor_offset + len(sensor)
    header = b"II" + pack("<HIH", 42, ifd_offset, len(tags))
    raw = header + b"".join(tiff_field(*field) for field in tags)
    raw += pack("<I", preview_ifd if with_preview else 0) + camera + sensor
    if not with_preview:
        return raw
    preview_tags = [
        (254, 4, 1, 1), (256, 4, 1, WIDTH), (257, 4, 1, HEIGHT),
        (259, 3, 1, 6), (262, 3, 1, 6), (274, 3, 1, 1),
        (513, 4, 1, 0), (514, 4, 1, len(preview)),
    ]
    jpeg_offset = preview_ifd + 2 + len(preview_tags) * 12 + 4
    preview_directory = b"".join(
        tiff_field(tag, kind, count, jpeg_offset if tag == 513 else value)
        for tag, kind, count, value in preview_tags
    )
    return raw + pack("<H", len(preview_tags)) + preview_directory + pack("<I", 0) + preview


if __name__ == "__main__":
    image = scene()
    (ROOT / "image-sample.psd").write_bytes(photoshop(image))
    (ROOT / "image-sample.dng").write_bytes(dng(image))
    (ROOT / "image-no-preview.dng").write_bytes(dng(image, with_preview=False))
