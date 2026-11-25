"""Inspect the media actually referenced by DOCX drawings, not unrelated images."""
from __future__ import annotations

import io
import math
import posixpath
import re
import xml.etree.ElementTree as ET

from .steps import StepError

NS = {
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

# Contextual shaping, bidi and combining marks keep renderer-owned semantics;
# every other label must be pinned to measured glyph positions.
CONTEXTUAL_TEXT = re.compile(
    "[\u0300-\u036f\u0591-\u05f4\u0600-\u06ff\u0750-\u077f\u0900-\u097f\u0980-\u09ff\u200c\u200d\ufe00-\ufe0f]"
)


def _tag(element):
    return element.tag.rsplit("}", 1)[-1]


def inspect_vector_text(svg, context="Word vector"):
    """Every plain label in an Office vector must carry explicit glyph runs.

    Office-family SVG importers do not reliably honor text-anchor,
    dominant-baseline or relative tspan coordinate chains: center-anchored
    C4-style rows render start-anchored and push labels to the right half of
    their box. The exporter pins browser-measured positions; a vector that
    again relies on those attributes is a placement regression.
    """
    positioned = 0
    for text in (node for node in svg.iter() if _tag(node) == "text"):
        content = "".join(text.itertext())
        if not content.strip() or CONTEXTUAL_TEXT.search(content):
            continue
        anchor = text.get("text-anchor")
        if anchor not in (None, "start"):
            raise StepError(f"{context} label relies on the {anchor} text anchor instead of measured positions")
        leaves = [node for node in text.iter() if _tag(node) == "tspan" and not list(node) and (node.text or "").strip()]
        if not leaves:
            raise StepError(f"{context} label was not pinned to measured glyph positions: {content[:24]!r}")
        for span in leaves:
            if span.get("text-anchor") not in (None, "start"):
                raise StepError(f"{context} glyph run still relies on a text anchor: {(span.text or '')[:24]!r}")
            if span.get("x") is None:
                raise StepError(f"{context} glyph run inherits its position instead of a measured x: {(span.text or '')[:24]!r}")
            try:
                point = [float(span.get(name, "")) for name in ("x", "y")]
                if not all(math.isfinite(value) for value in point):
                    raise ValueError()
            except ValueError as error:
                raise StepError(f"{context} glyph run has invalid measured coordinates: {(span.text or '')[:24]!r}") from error
            positioned += 1
    return positioned


def inspect_equations(archive):
    """The shared Markdown fixture has x squared and one half, each exactly once.

    Validate semantic OOXML and surrounding prose separately: aggregate itertext
    alone also accepted the old three-layer KaTeX export with duplicated text.
    """
    document = ET.fromstring(archive.read("word/document.xml"))
    equations = document.findall(".//m:oMath", NS)
    if len(equations) != 2:
        raise StepError("DOCX must contain exactly two editable equations")
    expected = [("sSup", ["x", "2"]), ("f", ["1", "2"])]
    for equation, (structure, tokens) in zip(equations, expected):
        if equation.find(f"m:{structure}", NS) is None or [node.text for node in equation.findall(".//m:t", NS)] != tokens:
            raise StepError("DOCX formula structure or tokens changed")
    paragraphs = ["".join(node.text or "" for node in paragraph.findall(".//w:t", NS))
                  for paragraph in document.findall(".//w:p", NS)]
    if [text for text in paragraphs if text.startswith("Math:")] != ["Math:  and ."]:
        raise StepError("DOCX math prose contains duplicated visual text or TeX")
    return {"equationCount": len(equations), "structures": [item[0] for item in expected]}


def inspect_diagrams(archive, minimum_dpi=285):
    """Check diagram sampling and layout and return raw measurements for review.

    Raster density and OOXML geometry establish the packaging contract. They do
    not prove actual Word typography, display scaling or visual clarity.
    """
    from PIL import Image

    document = ET.fromstring(archive.read("word/document.xml"))
    relationships = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
    targets = {item.get("Id"): item for item in relationships}
    section = document.find(".//w:sectPr", NS)
    page = section.find("w:pgSz", NS) if section is not None else None
    margins = section.find("w:pgMar", NS) if section is not None else None
    available_width_emu = None
    if page is not None and margins is not None:
        get = lambda item, name: int(item.get(f"{{{NS['w']}}}{name}", "0"))
        available_width_emu = (get(page, "w") - get(margins, "left") - get(margins, "right")) * 635
    measurements = []
    for drawing in document.findall(".//w:drawing", NS):
        properties = drawing.find(".//wp:docPr", NS)
        if properties is None or properties.get("title", "").lower() != "diagram":
            continue
        extent = drawing.find(".//wp:extent", NS)
        blip = drawing.find(".//a:blip", NS)
        if extent is None or blip is None:
            raise StepError("DOCX diagram has no drawing extent or image relationship")
        width, height = int(extent.get("cx", "0")), int(extent.get("cy", "0"))
        if min(width, height) <= 0:
            raise StepError("DOCX diagram has an empty physical display size")
        if available_width_emu is not None and width > available_width_emu + 9525:
            raise StepError("DOCX diagram exceeds the page content width")
        relationship = targets.get(blip.get(f"{{{NS['r']}}}embed"))
        if relationship is None or relationship.get("TargetMode") == "External":
            raise StepError("DOCX diagram does not reference embedded media")
        media = posixpath.normpath(posixpath.join("word", relationship.get("Target", "")))
        if not media.startswith("word/media/"):
            raise StepError("DOCX diagram media escapes the document media directory")
        data = archive.read(media)
        vector_media = []
        for vector in drawing.iter():
            if vector.tag.rsplit("}", 1)[-1] != "svgBlip":
                continue
            vector_relationship = targets.get(vector.get(f"{{{NS['r']}}}embed"))
            if vector_relationship is None or vector_relationship.get("TargetMode") == "External":
                raise StepError("DOCX SVG extension has no embedded vector relationship")
            vector_path = posixpath.normpath(posixpath.join("word", vector_relationship.get("Target", "")))
            if not vector_path.startswith("word/media/") or not vector_path.endswith(".svg"):
                raise StepError("DOCX SVG extension references invalid media")
            vector_root = ET.fromstring(archive.read(vector_path))
            if vector_root.tag.rsplit("}", 1)[-1] != "svg":
                raise StepError("DOCX vector media is not an SVG document")
            vector_media.append(vector_path)
        if media.endswith(".svg"):
            measurements.append({"media": media, "vector": True, "widthEmu": width, "heightEmu": height})
            continue
        with Image.open(io.BytesIO(data)) as image:
            pixels_w, pixels_h = image.size
        dpi_x, dpi_y = pixels_w / (width / 914400), pixels_h / (height / 914400)
        aspect_error = abs((pixels_w / pixels_h) / (width / height) - 1)
        if min(dpi_x, dpi_y) < minimum_dpi:
            raise StepError(f"DOCX diagram sampling too low: {dpi_x:.1f}x{dpi_y:.1f} DPI")
        if aspect_error > .02:
            raise StepError("DOCX diagram media and drawing aspect ratios differ")
        measurements.append({"media": media, "vector": False, "widthEmu": width, "heightEmu": height,
                             "pixelWidth": pixels_w, "pixelHeight": pixels_h,
                             "dpiX": dpi_x, "dpiY": dpi_y, "aspectError": aspect_error,
                             "vectorMedia": vector_media})
    if not measurements:
        raise StepError("DOCX contains no identifiable Mermaid diagram drawing")
    return measurements
