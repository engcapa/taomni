"""Inspect the visible second page of the edited visio-routing.vsdx fixture."""
import numpy as np
import pymupdf

from .steps import StepError


DPI = 144
PIXELS_PER_POINT = DPI / 72


def shape_bounds(rgb, name, color, expected):
    # Include antialiased/compressed fills, but distinguish the blue first
    # page from the green second page and both from the light yellow node.
    mask = np.max(np.abs(rgb - color), axis=2) <= 7
    y, x = np.nonzero(mask)
    if not x.size:
        raise StepError(f"Visio PDF lost the {name} fill")
    bounds = np.array([x.min(), y.min(), x.max() + 1, y.max() + 1]) / PIXELS_PER_POINT
    left, top, right, bottom = expected
    area = (right - left) * (bottom - top) * PIXELS_PER_POINT ** 2
    if np.max(np.abs(bounds - expected)) > 2 or x.size < area * 0.75:
        raise StepError(f"Visio PDF {name} has incorrect visible bounds or fill area: {bounds.tolist()}")
    return bounds.tolist()


def inspect_visio_review(path):
    with pymupdf.open(path) as document:
        if not document.is_pdf or document.needs_pass or len(document) != 1:
            raise StepError("Visio review export must be a readable, single-page PDF")
        page = document[0]
        width, height = page.rect.width, page.rect.height
        if abs(width - 576) > 0.5 or abs(height - 288) > 0.5:
            raise StepError(f"Visio PDF lost the 8 by 4 inch sheet: {width} by {height} pt")
        pixmap = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csRGB, alpha=False)
        rgb = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, 3).astype(np.int16)

    # Both source pages are the same size. Page 2 has a green approval node,
    # and editing PinX from 6 to 4.25 inches moves the delivery node left.
    approval = shape_bounds(rgb, "approval node", (223, 237, 219), (72, 115.2, 216, 172.8))
    delivery = shape_bounds(rgb, "edited delivery node", (242, 239, 215), (234, 115.2, 378, 172.8))

    # The updated label spans well beyond the original "Delivery". Measure
    # only dark, neutral glyphs inside the node to exclude its blue outline.
    label = rgb[round(122 * PIXELS_PER_POINT):round(165 * PIXELS_PER_POINT),
                round(235 * PIXELS_PER_POINT):round(376 * PIXELS_PER_POINT)]
    ink = (label.max(axis=2) < 100) & (np.ptp(label, axis=2) < 20)
    y, x = np.nonzero(ink)
    span = (int(np.ptp(x)) + 1) / PIXELS_PER_POINT if x.size else 0
    if span < 75 or x.size < 120 or np.ptp(y) < 5 * PIXELS_PER_POINT:
        raise StepError(f"Visio PDF lost or clipped the edited delivery label: {span} pt of visible ink")
    return {"pageCount": 1, "pageSizePt": [width, height], "renderDpi": DPI,
            "approvalBoundsPt": approval, "deliveryBoundsPt": delivery,
            "deliveryLabelWidthPt": span, "deliveryLabelPixels": int(x.size)}
