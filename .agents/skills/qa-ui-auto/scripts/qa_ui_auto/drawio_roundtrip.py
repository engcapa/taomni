"""Compare rendered WebView pixels and editable export XML with a draw.io original."""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from .steps import StepError

# These colors identify shapes, outlines, labels and arrows independently in
# the Desktop reference, so a large rectangle cannot hide a missing connector.
FEATURES = {
    "rounded rectangle": ("#9ac6ff", 0.97),
    "diamond": ("#ffd470", 0.97),
    "ellipse": ("#7ed9a8", 0.97),
    "outlines": ("#47668c", 0.93),
}

# Individual label regions in the Desktop reference after trimming its margin.
LABEL_REGIONS = {
    "Load request": (12, 26, 118, 56),
    "Submit": (138, 26, 194, 56),
    "Validate": (240, 26, 320, 56),
    "OK": (283, 98, 322, 132),
    "Retry": (56, 171, 114, 211),
    "Save result": (225, 170, 339, 211),
}


def _content(path):
    from PIL import Image, ImageChops

    with Image.open(path) as source:
        image = source.convert("RGBA")
    white = Image.new("RGBA", image.size, "white")
    pixels = Image.alpha_composite(white, image).convert("RGB")
    difference = ImageChops.difference(pixels, white.convert("RGB")).convert("L")
    bounds = difference.point(lambda value: 255 if value >= 10 else 0).getbbox()
    if bounds is None:
        raise StepError(f"draw.io comparison has no visible diagram in {path.name}")
    return pixels.crop(bounds)


def compare_images(reference, captured, report, label):
    """Normalize outer padding and scale, allowing a small rasterization tolerance."""
    import numpy as np
    from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageFilter

    expected, observed = _content(reference), _content(captured)
    aspect_error = abs((observed.width / observed.height) / (expected.width / expected.height) - 1)
    metrics = {"originalSize": expected.size, "observedSize": observed.size, "aspectError": aspect_error, "features": {}}
    failures = ["diagram proportions changed"] if aspect_error > 0.035 else []
    actual = observed.resize(expected.size, Image.Resampling.LANCZOS)
    expected_pixels, actual_pixels = np.asarray(expected, dtype=np.int16), np.asarray(actual, dtype=np.int16)

    def compare_mask(name, before, after, threshold, radius):
        neighbors = ImageFilter.MaxFilter(2 * radius + 1)
        before_near = np.asarray(Image.fromarray(before.astype("uint8") * 255).filter(neighbors)) > 0
        after_near = np.asarray(Image.fromarray(after.astype("uint8") * 255).filter(neighbors)) > 0
        retained = (before & after_near).sum() / max(1, before.sum())
        matched = (after & before_near).sum() / max(1, after.sum())
        metrics["features"][name] = {"referencePixels": int(before.sum()), "observedPixels": int(after.sum()),
                                      "retained": round(retained, 4), "matched": round(matched, 4)}
        if min(retained, matched) < threshold:
            failures.append(f"{name} retained {retained:.1%}, matched {matched:.1%} (requires {threshold:.0%})")

    # Glyph antialiasing varies by WebView. Include antialiased dark strokes,
    # and check each label's position independently, including short labels.
    before_ink = np.max(expected_pixels, axis=2) <= 124
    after_ink = np.max(actual_pixels, axis=2) <= 124
    outside_labels = np.ones(before_ink.shape, dtype=bool)
    for label_name, (left, top, right, bottom) in LABEL_REGIONS.items():
        compare_mask(f"{label_name} label", before_ink[top:bottom, left:right],
                     after_ink[top:bottom, left:right], 0.90, radius=3)
        outside_labels[top:bottom, left:right] = False

    for name, (color, threshold) in FEATURES.items():
        rgb = np.array(ImageColor.getrgb(color), dtype=np.int16)
        before = np.max(np.abs(expected_pixels - rgb), axis=2) <= 22
        after = np.max(np.abs(actual_pixels - rgb), axis=2) <= 22
        if name == "outlines":
            # The reference outlines stay outside the label regions. Text
            # antialiasing over a fill can otherwise match the outline color.
            before &= outside_labels
            after &= outside_labels
        compare_mask(name, before, after, threshold, radius=2)

    arrow_ink = 255 - np.array(ImageColor.getrgb("#8b30ce"), dtype=float)

    def arrow_mask(pixels):
        # A connector at reduced scale can cover only part of an output pixel.
        # Match the ink composited over the white diagram background.
        shade = 255 - pixels
        coverage = (shade @ arrow_ink) / (arrow_ink @ arrow_ink)
        blended = coverage[..., None] * arrow_ink
        color_error = np.max(np.abs(shade - blended), axis=2)
        return (coverage >= 0.30) & (color_error <= 20)

    compare_mask("arrows", arrow_mask(expected_pixels), arrow_mask(actual_pixels), 0.91, radius=2)

    comparison = Image.new("RGB", (3 * expected.width + 32, expected.height + 36), "#f1f5f9")
    drawing = ImageDraw.Draw(comparison)
    for index, (title, image) in enumerate((("draw.io Desktop original", expected), (label, actual),
                                             ("Pixel difference", ImageChops.difference(expected, actual)))):
        x = 8 + index * (expected.width + 8)
        drawing.text((x, 7), title, fill="#172554")
        comparison.paste(image, (x, 28))
    comparison.save(report.with_suffix(".png"))
    metrics["failures"] = failures
    report.with_suffix(".json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    if failures:
        raise StepError("draw.io preview differs from the Desktop reference: " + "; ".join(failures))


def _sheet(path):
    data = path.read_bytes()
    if len(data) > 20 * 1024 * 1024 or re.search(rb"<!DOCTYPE|<!ENTITY", data, re.I):
        raise StepError(f"unsafe or oversized draw.io file: {path.name}")
    document = ET.fromstring(data)
    pages = document.findall("diagram")
    if document.tag != "mxfile" or len(pages) != 1:
        raise StepError(f"expected exactly one editable draw.io sheet: {path.name}")
    model = pages[0].find("mxGraphModel")
    if model is None or model.find("root") is None:
        raise StepError(f"missing editable mxGraphModel: {path.name}")
    return pages[0].get("name", ""), model


def _element(element):
    return element.tag, dict(element.attrib), [_element(child) for child in element]


def _cell_graph(cells):
    raw_ids = {cell.get("id") for cell in cells}
    result = {}
    for cell in cells:
        attrs = dict(cell.attrib)
        for key in ("parent", "source", "target"):
            if key in attrs and attrs[key] not in raw_ids:
                raise StepError(f"draw.io cell {attrs.get('id')!r} refers to a missing {key}")
        identity = attrs.pop("id", "")
        if cell.tag != "mxCell" or not identity or identity in result:
            raise StepError("round-trip lost unique editable mxCell identities")
        result[identity] = (attrs, [_element(child) for child in cell])
    return result


def compare_export(original, exported):
    original_title, source_model = _sheet(original)
    export_title, target_model = _sheet(exported)
    if export_title != original_title and not export_title.endswith(" · " + original_title):
        raise StepError(f"draw.io sheet name changed: {export_title!r}")
    if source_model.attrib != target_model.attrib:
        raise StepError("draw.io page settings changed")
    expected = _cell_graph(source_model.find("root"))
    actual = _cell_graph(target_model.find("root"))
    if expected.keys() != actual.keys():
        raise StepError(f"draw.io editable cells changed: expected {list(expected)}, found {list(actual)}")
    for identity, (attrs, geometry) in expected.items():
        if actual[identity] != (attrs, geometry):
            raise StepError(f"draw.io cell {identity!r} changed label, geometry, style or endpoint")
    return {
        "sheet": export_title,
        "vertices": [identity for identity, (attrs, _) in actual.items() if attrs.get("vertex") == "1"],
        "edges": {identity: [attrs.get("source"), attrs.get("target")]
                  for identity, (attrs, _) in actual.items() if attrs.get("edge") == "1"},
    }


_SVG_DETAILS = """svg => {
    if (!svg) return null;
    const bounds = svg.getBoundingClientRect();
    return {labels: Array.from(svg.querySelectorAll("text,foreignObject"))
                .filter(text => text.localName === "foreignObject" || !text.closest("switch"))
                .map(text => text.textContent.trim()).filter(Boolean),
            rect: [bounds.left, bounds.top, bounds.right, bounds.bottom],
            viewport: [window.innerWidth, window.innerHeight]};
}"""


def assert_preview(ctx, args):
    if args not in ("live", "split"):
        raise StepError("assert_drawio_preview expects live or split")
    if getattr(ctx, "dry_run", False):
        return "dry-run"
    from PIL import Image

    pane = "markdown-live" if args == "live" else "markdown-preview"
    selector = f'[data-testid="{pane}"] .fv-md-drawio > svg'
    artifact = ctx.case_dir / f"drawio-{args}"
    captured = artifact.with_suffix(".png")
    if ctx.cfg["app"]["mode"] == "native":
        details = ctx.session.execute(f"return ({_SVG_DETAILS})(document.querySelector({json.dumps(selector)}));")
        if not details:
            raise StepError(f"no rendered draw.io in {pane}")
        left, top, right, bottom = details["rect"]
        width, height = details["viewport"]
        if not (0 <= left < right <= width and 0 <= top < bottom <= height):
            raise StepError(f"draw.io is outside the native viewport: {details}")
        viewport = ctx.case_dir / f"drawio-{args}-viewport.png"
        ctx.session.screenshot(viewport)
        with Image.open(viewport) as image:
            scale_x, scale_y = image.width / width, image.height / height
            image.crop((round(left * scale_x), round(top * scale_y),
                        round(right * scale_x), round(bottom * scale_y))).save(captured)
    else:
        locator = ctx.page.locator(selector)
        details = locator.evaluate(_SVG_DETAILS)
        locator.screenshot(path=str(captured), scale="css")
    compare_images(ctx.case_dir / "roundtrip.drawio.png", captured,
                   ctx.case_dir / f"drawio-{args}-comparison", f"Markdown {args.capitalize()}")
    _, model = _sheet(ctx.case_dir / "roundtrip.drawio")
    cells = model.find("root")
    expected_labels = sorted(cell.get("value") for cell in cells if cell.get("value"))
    if sorted(details["labels"]) != expected_labels:
        raise StepError(f"draw.io visible labels changed: {details['labels']!r}")
    return f"draw.io {args} pixels and {len(expected_labels)} labels match Desktop reference"


def assert_export(ctx, args):
    if args not in ("download", "save"):
        raise StepError("assert_drawio_roundtrip expects download or save")
    if getattr(ctx, "dry_run", False):
        return "dry-run"
    if args == "download":
        paths = list(ctx.case_dir.glob("download-*-drawio-roundtrip.drawio"))
        if len(paths) != 1:
            raise StepError(f"expected one browser draw.io download, found {len(paths)}")
        exported = paths[0]
    else:
        exported = ctx.case_dir / "roundtrip-export.drawio"
    result = compare_export(ctx.case_dir / "roundtrip.drawio", exported)
    (ctx.case_dir / "drawio-export-graph.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return f"draw.io round trip preserved {len(result['vertices'])} editable nodes and {len(result['edges'])} connected edges"
