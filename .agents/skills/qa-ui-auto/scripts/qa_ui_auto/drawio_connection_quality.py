"""Check serialized anchors against draw.io's legacy connection-point rules.

draw.io defaults anchorPointDirection to 1; maxGraph defaults it to false.
An XML cell/waypoint count cannot detect the resulting displaced connectors.
"""
import math
from .steps import StepError


def style_of(cell):
    return dict(part.split("=", 1) for part in cell.get("style", "").split(";") if "=" in part)


def connection_point(cell, edge_style, terminal):
    geometry = cell.find("mxGeometry")
    style = style_of(cell)
    x, y, width, height = (float(geometry.get(key, "0")) for key in ("x", "y", "width", "height"))
    cx, cy = x + width / 2, y + height / 2
    direction = style.get("direction", "east")
    direction_angle = 0
    if style.get("anchorPointDirection", "1") == "1":
        direction_angle = {"south": 90, "west": 180, "north": 270}.get(direction, 0)
        if direction in {"north", "south"}:
            width, height = height, width
            x, y = cx - width / 2, cy - height / 2
    px = x + float(edge_style[terminal + "X"]) * width + float(edge_style.get(terminal + "Dx", "0"))
    py = y + float(edge_style[terminal + "Y"]) * height + float(edge_style.get(terminal + "Dy", "0"))
    flip_h, flip_v = style.get("flipH", "0") == "1", style.get("flipV", "0") == "1"
    if direction in {"north", "south"}:
        flip_h, flip_v = flip_v, flip_h
    if flip_h:
        px = 2 * cx - px
    if flip_v:
        py = 2 * cy - py
    angle = math.radians(float(style.get("rotation", "0")) + direction_angle)
    dx, dy = px - cx, py - cy
    return cx + dx * math.cos(angle) - dy * math.sin(angle), cy + dx * math.sin(angle) + dy * math.cos(angle)


def inspect_sequence_connections(cells):
    maximum_error = 0.0
    checked = 0
    for cell in cells.values():
        if cell.get("taomniKind") != "sequence-message":
            continue
        edge_style = style_of(cell)
        for name, anchor in (("source", "exit"), ("target", "entry")):
            vertex = cells.get(cell.get(name))
            point = cell.find("mxGeometry/mxPoint[@as='" + name + "Point']")
            if vertex is None or point is None or any(anchor + key not in edge_style for key in ("X", "Y")):
                raise StepError("Sequence message lost its connected endpoint")
            if edge_style.get(anchor + "Perimeter", "1") != "0" or style_of(vertex).get("legacyAnchorPoints", "1") != "1":
                raise StepError("Sequence message uses unsupported perimeter/anchor semantics")
            actual = connection_point(vertex, edge_style, anchor)
            expected = float(point.get("x")), float(point.get("y"))
            error = math.hypot(actual[0] - expected[0], actual[1] - expected[1])
            if not math.isfinite(error) or error > 1.5:
                raise StepError(f"draw.io routed sequence endpoint away from Mermaid: {cell.get('id')} {name}, error={error:.3f}px")
            maximum_error = max(maximum_error, error)
            checked += 1
    return {"checkedSequenceEndpoints": checked, "maximumEndpointError": round(maximum_error, 3)}
