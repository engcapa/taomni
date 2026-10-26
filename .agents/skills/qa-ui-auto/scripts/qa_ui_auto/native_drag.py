"""One-request native drags: pointer state never crosses a macOS bridge request."""

from __future__ import annotations

from contextlib import suppress
import json
import math
from pathlib import Path
from typing import Any, Protocol

from .steps import StepError
from .steps.mouse import drag_offset


class DragSession(Protocol):
    def find(self, selector: str, *, interactive: bool = False) -> str: ...
    def execute(self, script: str) -> Any: ...
    def endpoint(self, path: str) -> str: ...
    def request(self, method: str, path: str, data: dict | None = None) -> Any: ...


class DragContext(Protocol):
    session: DragSession
    case_dir: Path


def _centre(session: DragSession, selector: str) -> tuple[int, int]:
    session.find(selector, interactive=False)
    box = session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        "const r = el?.getBoundingClientRect();"
        "return r ? {x:r.x,y:r.y,width:r.width,height:r.height} : null;"
    )
    if (not isinstance(box, dict) or any(not isinstance(box.get(k), (int, float))
            or not math.isfinite(box[k]) for k in ("x", "y", "width", "height"))
            or box["width"] <= 0 or box["height"] <= 0):
        raise StepError(f"drag_to: {selector} has no layout box")
    return round(box["x"] + box["width"] / 2), round(box["y"] + box["height"] / 2)


def native_drag(ctx: DragContext, args: Any) -> str:
    if not isinstance(args, dict) or "from" not in args:
        raise StepError("drag_to: expected {from, to|by}")
    if "from_position" in args or "to_position" in args:
        raise StepError("drag_to: element-relative explicit positions are browser-only")
    start = _centre(ctx.session, args["from"])
    offset = drag_offset(args)
    if offset is None:
        end = _centre(ctx.session, args["to"])
        steps = 8
    else:
        dx, dy, steps = offset
        if not math.isfinite(dx) or not math.isfinite(dy):
            raise StepError("drag_to: offsets must be finite")
        end = (round(start[0] + dx), round(start[1] + dy))
    actions = [{"type": "pointerMove", "duration": 0, "origin": "viewport", "x": start[0], "y": start[1]},
               {"type": "pointerDown", "button": 0}]
    for step in range(1, steps + 1):
        actions.append({"type": "pointerMove", "duration": 16, "origin": "viewport",
                        "x": round(start[0] + (end[0] - start[0]) * step / steps),
                        "y": round(start[1] + (end[1] - start[1]) * step / steps)})
    actions.append({"type": "pointerUp", "button": 0})
    with (ctx.case_dir / "native-drags.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"args": args, "start": start, "end": end, "actions": actions}) + "\n")
    try:
        ctx.session.request("POST", ctx.session.endpoint("/actions"), {"actions": [{
            "type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": actions,
        }]})
    finally:
        with suppress(Exception):
            ctx.session.request("DELETE", ctx.session.endpoint("/actions"))
    return f"dragged {start} -> {end} in {steps} moves"
