"""Native pointer delivery to the RDP renderer's remote desktop coordinates."""

import json

from native_pointer import click_viewport_point

from ..steps import StepError

CANVAS = '[data-testid="rdp-canvas"]'


def click_canvas(session, x, y, selector=CANVAS):
    geometry = session.execute(
        "const c = document.querySelector(" + json.dumps(selector) + ");"
        "if (!c) return null; const r = c.getBoundingClientRect();"
        "return {left: r.left, top: r.top, width: r.width, height: r.height,"
        " desktopWidth: c.width, desktopHeight: c.height};"
    )
    if not isinstance(geometry, dict) or not geometry.get("width"):
        raise StepError(f"rdp_canvas_click: canvas {selector} not found or not laid out")
    sx = float(geometry["width"]) / float(geometry["desktopWidth"] or geometry["width"])
    sy = float(geometry["height"]) / float(geometry["desktopHeight"] or geometry["height"])
    vx = int(geometry["left"] + float(x) * sx)
    vy = int(geometry["top"] + float(y) * sy)
    click_viewport_point(session, vx, vy, move_ms=50, hold_ms=60)
    return f"clicked desktop ({x},{y}) at viewport ({vx},{vy}) scale {sx:.3f}x{sy:.3f}"
