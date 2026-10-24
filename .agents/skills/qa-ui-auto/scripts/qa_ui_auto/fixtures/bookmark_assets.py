"""Local raster fixture for native bookmark background loading."""
from pathlib import Path
import struct
import tempfile
import zlib


def setup(ctx):
    root = Path(ctx.report_root).resolve() / "bookmark-assets"
    root.mkdir(parents=True, exist_ok=True)
    owned = Path(tempfile.mkdtemp(prefix="background-", dir=root))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress((b"\x00" + b"\x30\x70\xb0" * 4) * 4)) + chunk(b"IEND", b"")
    path = owned / "background.png"
    path.write_bytes(png)
    ctx.values["bookmark_background"] = path.as_posix()
