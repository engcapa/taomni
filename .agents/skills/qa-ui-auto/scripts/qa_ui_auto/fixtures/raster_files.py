"""One isolated raster-viewer workflow; real encoded pixels and size boundaries."""
from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from . import platform_workspace_root


def image_files() -> dict[str, bytes]:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (640, 360), "#18324f")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 319, 179), fill="#dd3344")
    draw.rectangle((320, 0, 639, 179), fill="#33aa77")
    draw.rectangle((0, 180, 319, 359), fill="#3388dd")
    draw.rectangle((320, 180, 639, 359), fill="#f0c040")
    files: dict[str, bytes] = {}
    for name, kind in (("01-landscape.png", "PNG"), ("02-photo.jpg", "JPEG"),
                       ("03-lossless.webp", "WEBP"), ("04-palette.gif", "GIF")):
        output = io.BytesIO()
        image.save(output, kind, **({"lossless": True} if kind == "WEBP" else {}))
        files[name] = output.getvalue()
    files["90-corrupt.png"] = b"not a PNG image\x00\xff"
    # A valid PNG with trailing bytes probes compressed-file budgets, not a
    # decompression bomb. Both preview and viewer must decide before decoding.
    files["91-preview-limit.png"] = files["01-landscape.png"]
    files["92-viewer-limit.png"] = files["01-landscape.png"]
    return files


def setup(ctx: Any) -> None:
    platform_workspace_root.setup(ctx)
    native = (ctx.cfg.get("app") or {}).get("mode") == "native"
    root = ctx.values["platform_workspace_root"] + "/raster-" + uuid4().hex[:10]
    files = image_files()
    sizes = {"91-preview-limit.png": 20 * 1024 * 1024 + 1, "92-viewer-limit.png": 32 * 1024 * 1024 + 1}
    if native:
        Path(root).mkdir(parents=True)
        for name, data in files.items():
            path = Path(root) / name
            path.write_bytes(data)
            if name in sizes:
                with path.open("r+b") as stream:
                    stream.truncate(sizes[name])
    else:
        ctx.page.evaluate("""async ({root, files, sizes}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          await vfs.vfsMkdir(root);
          for (const [name, b64] of Object.entries(files)) {
            const original = Uint8Array.from(atob(b64), character => character.charCodeAt(0));
            const bytes = sizes[name] ? new Uint8Array(sizes[name]) : original;
            if (sizes[name]) bytes.set(original);
            await vfs.vfsWriteBytes(root + '/' + name, bytes.buffer);
          }
        }""", {"root": root, "files": {name: base64.b64encode(data).decode("ascii") for name, data in files.items()}, "sizes": sizes})
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items() if name not in sizes}
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    oracle = ctx.case_dir / "raster-original.png"
    oracle.write_bytes(files["01-landscape.png"])
    ctx.values.update({"file_open_root": root, "raster_root": root, "raster_png": root + "/01-landscape.png",
                       "raster_png_oracle": oracle.as_posix(), "raster_png_sha": hashes["01-landscape.png"],
                       "raster_jpeg_sha": hashes["02-photo.jpg"], "raster_webp_sha": hashes["03-lossless.webp"],
                       "raster_gif_sha": hashes["04-palette.gif"]})
    (ctx.case_dir / "file-open-fixture.json").write_text(json.dumps({
        "schema": "qa.file-open-fixture.v1", "mode": "native" if native else "browser", "root": root,
        "files": hashes, "size_boundaries": sizes, "raster_oracle": str(oracle),
        "boundary": "Real native files/OS clipboard or browser VFS/Chromium clipboard; no synthetic viewer state.",
    }, indent=2) + "\n", encoding="utf-8")


def teardown(ctx: Any) -> None:
    platform_workspace_root.teardown(ctx)
