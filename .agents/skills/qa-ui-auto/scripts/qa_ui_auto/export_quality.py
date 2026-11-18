"""Independent file-format checks for actual PDF/DOCX exports."""
import io
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

from .steps import StepError

EXPORT_KINDS = {"pdf", "docx", "drawio", "drawio-png", "testing-pdf", "testing-docx"}


def inspect_swimlane_png(path):
    import numpy as np
    from PIL import Image

    with Image.open(path) as image:
        width, height = image.size
        # The reference sheet is 466×276 CSS px. Allow for WebView bounds rounding.
        if image.format != "PNG" or abs(width - 1457) > 12 or abs(height - 863) > 12:
            raise StepError(f"draw.io PNG has an unexpected format or resolution: {image.format} {width}×{height}")
        rgba = np.asarray(image.convert("RGBA"))
    rgb, alpha = rgba[:, :, :3].astype(np.int16), rgba[:, :, 3]
    y, x = np.where((np.max(np.abs(rgb - (255, 242, 204)), axis=2) <= 3) & (alpha > 240))
    if x.size < 20_000:
        raise StepError("draw.io PNG lost the yellow request node")
    left, right, top, bottom = x.min(), x.max(), y.min(), y.max()
    label = (np.max(rgb, axis=2) <= 100) & (alpha > 100)
    label_pixels = label[top + 25:bottom - 25, left + 25:right - 25].sum()
    if label_pixels < 100:
        raise StepError("draw.io PNG lost the request label")
    return {"width": width, "height": height, "yellowNodePixels": int(x.size), "labelPixels": int(label_pixels)}


def raster_grid_pixels(image):
    # The fixture's original bitmap has red/blue grid lines. Diagram outlines
    # and a nonblank page alone cannot prove that this separate image survived.
    width = min(800, image.width)
    sample = image.resize((width, max(1, round(image.height * width / image.width))))
    red = blue = 0
    for r, g, b in sample.getdata():
        red += r > g + 50 and r > b + 70 and g < 160
        blue += b > r + 60 and b > g + 30 and g < 160
    return {"red": red, "blue": blue}


def inspect_quality(path, kind):
    if kind == "drawio-png":
        return inspect_swimlane_png(path)
    if kind in {"testing-pdf", "testing-docx"}:
        from .markdown_testing_quality import inspect_testing
        return inspect_testing(path, kind)
    if kind == "drawio":
        from .drawio_export_quality import inspect_drawio
        return inspect_drawio(path)
    data = Path(path).read_bytes()
    if kind == "pdf":
        from pypdf import PdfReader
        from PIL import ImageStat
        reader = PdfReader(io.BytesIO(data), strict=True)
        if len(reader.pages) < 3:
            raise StepError("Quality PDF must retain the complete multi-page document")
        pages = []
        extracted_pages = []
        for page in reader.pages:
            width, height = float(page.mediabox.width), float(page.mediabox.height)
            if abs(width - 595.28) > 1 or abs(height - 841.89) > 1:
                raise StepError("PDF lost the selected A4 portrait paper size")
            draws = [operands[0] for operands, operator in page.get_contents().operations if operator == b"Do"]
            if len(draws) != 1:
                raise StepError("PDF must contain one complete rendered page image")
            image = page.images[draws[0]].image.convert("RGB")
            dpi = min(image.width / (width / 72), image.height / (height / 72))
            if dpi < 299 or max(ImageStat.Stat(image).stddev) < 3:
                raise StepError("PDF page is blank or below 300 DPI")
            pages.append(dict(width=image.width, height=image.height, dpi=dpi, rasterGridPixels=raster_grid_pixels(image)))
            extracted_pages.append(page.extract_text() or "")
        if any(sum(page["rasterGridPixels"][color] for page in pages) < 250 for color in ("red", "blue")):
            raise StepError("PDF lost the original raster grid pixels")
        text = "\n".join(extracted_pages)
        for required in ["Readable text", "中文检索", "café", "é", "😀", "用户 User", "No printer required", "Paragraph 20"]:
            if required not in text:
                raise StepError("PDF lost searchable Unicode text: " + required)
        if text.count("Paragraph 20:") != 1:
            raise StepError("PDF text layer duplicated the final paragraph across page slices")
        return dict(pages=pages, pageCount=len(pages), printerIndependentArtifact=True,
                    searchableUnicode=True, extractedPages=extracted_pages)
    if kind != "docx":
        raise StepError("Expected PDF or DOCX quality artifact")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if archive.testzip():
            raise StepError("DOCX ZIP checksum failed")
        xml = ET.fromstring(archive.read("word/document.xml"))
        if "Paragraph 20" not in "".join(xml.itertext()):
            raise StepError("Word export lost the end of the document")
        settings = archive.read("word/settings.xml")
        if b"doNotAutoCompressPictures" not in settings:
            raise StepError("Word export allows automatic picture compression")
        from .markdown_docx_quality import inspect_diagrams
        diagrams = inspect_diagrams(archive, minimum_dpi=590)
        vectors = [name for name in archive.namelist() if name.startswith("word/media/") and name.endswith(".svg")]
        if len(vectors) != 3:
            raise StepError("Word must preserve both Mermaid diagrams and the SVG image as vectors")
        labels = []
        for name in vectors:
            svg = ET.fromstring(archive.read(name))
            if any(node.tag.rsplit("}", 1)[-1] in {"foreignObject", "style"} for node in svg.iter()):
                raise StepError("Word vector still depends on HTML or scoped CSS")
            for node in svg.iter():
                if node.tag.rsplit("}", 1)[-1] == "text" and "".join(node.itertext()).strip():
                    if not node.get("font-size") or not node.get("fill"):
                        raise StepError("Word label has no explicit font size/color")
                    child = next((span for span in node.iter() if span is not node and span.tag.rsplit("}", 1)[-1] == "tspan" and "".join(span.itertext()).strip()), None)
                    if child is not None and child.get("stroke") == "none" and node.get("stroke") != "none":
                        raise StepError("Word text owner still inherits the box outline instead of label paint")
                    labels.append("".join(node.itertext()))
        for label in ["加载配置", "权限检查", "保存历史", "显示错误", "用户 User", "数据库 Database", "原始矢量文字"]:
            if not any(label in text for text in labels):
                raise StepError("Word vector lost label: " + label)
        from PIL import Image
        rasters = [Image.open(io.BytesIO(archive.read(name))).size for name in archive.namelist() if name.endswith(".png") and name.startswith("word/media/")]
        if (1600, 800) not in rasters:
            raise StepError("Word export downsampled the original raster image")
        return dict(vectorCount=len(vectors), labels=labels, diagrams=diagrams, originalRasterSize=[1600, 800])


def native(ctx, args):
    if not isinstance(args, dict) or set(args) != {"path", "kind"} or args["kind"] not in EXPORT_KINDS:
        raise StepError("assert_export_quality expects a path and a supported artifact kind")
    if getattr(ctx, "dry_run", False):
        return "dry-run export quality"
    path = Path(args["path"]).resolve()
    if not path.is_relative_to(ctx.case_dir.parent.resolve()):
        raise StepError("Export quality path is outside the retained run")
    result = inspect_quality(path, args["kind"])
    (ctx.case_dir / (args["kind"] + "-quality.json")).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return "Independent export quality matched: " + args["kind"]
