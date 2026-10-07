"""Independent browser PNG oracle; never supplies pixels to product exports."""
from __future__ import annotations

import base64
import io
import json
import math
from pathlib import Path

from . import StepContext, StepError, verb


def _png(data_url: str):
    from PIL import Image
    if not isinstance(data_url, str) or not data_url.startswith("data:image/png;base64,"):
        raise StepError("screenshot PNG oracle requires a retained data:image/png URL")
    image = Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1], validate=True)))
    image.load()
    return image.convert("RGBA")


def _inside(x, y, polygon):
    inside = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if (a["y"] > y) != (b["y"] > y) and x < a["x"] + (y - a["y"]) * (b["x"] - a["x"]) / (b["y"] - a["y"]):
            inside = not inside
    return inside


def _distance(x, y, polygon):
    distances = []
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        dx, dy = b["x"] - a["x"], b["y"] - a["y"]
        length = dx * dx + dy * dy
        t = max(0, min(1, ((x - a["x"]) * dx + (y - a["y"]) * dy) / length)) if length else 0
        distances.append(math.hypot(x - a["x"] - t * dx, y - a["y"] - t * dy))
    return min(distances)


def compare_mask(actual, source, crop, polygon, *, watermarked=False):
    """Fixed lossless thresholds plus exact nonboundary RGBA alpha values."""
    from PIL import Image
    x, y, w, h = (crop[k] for k in ("x", "y", "width", "height"))
    if x + w > source.width or y + h > source.height:
        raise StepError("reference crop is outside the original PNG")
    original = source.crop((x, y, x + w, y + h))
    expected = Image.new("RGBA", (w, h))
    diff = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    opaque = transparent = alpha_errors = total = bad = changed = 0
    tiles = {}
    for py in range(h):
        for px in range(w):
            interior = _inside(px + .5, py + .5, polygon)
            b = original.getpixel((px, py)) if interior else (0, 0, 0, 0)
            expected.putpixel((px, py), b)
            if actual.size != (w, h):
                continue
            a = actual.getpixel((px, py))
            boundary = _distance(px + .5, py + .5, polygon) <= 2
            if not boundary:
                opaque += int(interior)
                transparent += int(not interior)
                alpha_errors += int(a[3] != b[3])
            error = sum(abs(a[c] - b[c]) for c in range(3)) if interior and not boundary else 0
            total += error
            changed += int(error > 3)
            bad += int(error > 36)
            key = (px // 24, py // 24)
            tile_sum, count = tiles.get(key, (0, 0))
            tiles[key] = (tile_sum + error, count + 3)
            alpha = min(255, abs(a[3] - b[3]) * 4)
            diff.putpixel((px, py), (max(alpha, min(255, error * 4)), 0, alpha, 255))
    mean = total / (w * h * 3)
    bad_fraction = bad / (w * h)
    worst_tile = max((s / n for s, n in tiles.values()), default=255)
    # A scattered watermark intentionally changes interior RGB. In that
    # separate mode require visible marks, retained original background, and
    # the same exact alpha mask. Never weaken the pristine-image oracle.
    rgb_ok = (20 <= changed <= opaque * .25 if watermarked
              else mean <= 2 and bad_fraction <= .01 and worst_tile <= 5)
    metrics = {"passed": actual.size == (w, h) and opaque > 100 and transparent > 100
               and alpha_errors == 0 and rgb_ok,
               "watermarked": watermarked, "changedInteriorPixels": changed,
               "expectedSize": [w, h], "actualSize": list(actual.size),
               "opaquePixels": opaque, "transparentPixels": transparent, "alphaMismatches": alpha_errors,
               "meanRgbError": mean, "badPixelFraction": bad_fraction, "worstTileRgbError": worst_tile,
               "boundaryTolerancePixels": 2, "crop": crop, "polygon": polygon}
    return metrics, expected, diff


def _image(ctx: StepContext, selector: str):
    locator = ctx.page.locator(selector)
    if locator.count() != 1:
        raise StepError("PNG oracle requires exactly one image")
    info = locator.evaluate("el => ({loaded:el.complete, width:el.naturalWidth, height:el.naturalHeight, src:el.src})")
    if not info.get("loaded") or not info.get("width"):
        raise StepError("PNG oracle image has not decoded")
    image = _png(info["src"])
    if image.size != (info["width"], info["height"]):
        raise StepError("PNG dimensions differ from the rendered image")
    return image


@verb("screenshot_reference")
def step_screenshot_reference(ctx: StepContext, args):
    """Read the original image before the overlay closes; only QA state changes."""
    if not isinstance(args, dict) or set(args) != {"selector"}:
        raise StepError("screenshot_reference requires selector")
    if ctx.dry_run:
        return
    source = _image(ctx, args["selector"])
    path = ctx.case_dir / "screenshot-mask-original.png"
    source.save(path)
    ctx.case_state["screenshot_reference"] = path


@verb("assert_screenshot_mask")
def step_assert_screenshot_mask(ctx: StepContext, args):
    if (not isinstance(args, dict) or not {"selector", "crop", "polygon"} <= set(args)
            or set(args) - {"selector", "crop", "polygon", "watermarked"}
            or not isinstance(args.get("watermarked", False), bool)):
        raise StepError("assert_screenshot_mask requires selector, crop, polygon and optional watermarked boolean")
    crop, polygon = args["crop"], args["polygon"]
    if not isinstance(crop, dict) or set(crop) != {"x", "y", "width", "height"} or any(
            isinstance(v, bool) or not isinstance(v, int) or v < (1 if k in {"width", "height"} else 0)
            for k, v in crop.items()):
        raise StepError("mask crop requires nonnegative integer edges and positive dimensions")
    if not isinstance(polygon, list) or not 3 <= len(polygon) <= 256 or any(
            not isinstance(p, dict) or set(p) != {"x", "y"} or any(
                isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
                for v in p.values()) for p in polygon):
        raise StepError("mask polygon requires 3..256 finite x/y points")
    if ctx.dry_run:
        return
    from PIL import Image
    path = ctx.case_state.get("screenshot_reference")
    if not path:
        raise StepError("screenshot_reference must retain the original before export")
    with Image.open(Path(path)) as source:
        actual = _image(ctx, args["selector"])
        metrics, expected, diff = compare_mask(actual, source.convert("RGBA"), crop, polygon,
                                               watermarked=args.get("watermarked", False))
    prefix = f"screenshot-mask-{ctx.step_index}"
    actual.save(ctx.case_dir / f"{prefix}-actual.png")
    expected.save(ctx.case_dir / f"{prefix}-expected.png")
    diff.save(ctx.case_dir / f"{prefix}-difference.png")
    (ctx.case_dir / f"{prefix}-metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    if not metrics["passed"]:
        raise StepError(f"freehand PNG differs from original RGB/alpha: {metrics}")
