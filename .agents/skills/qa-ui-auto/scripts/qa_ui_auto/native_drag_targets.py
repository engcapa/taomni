"""Prepare both real, visible native drag endpoints before pressing a button."""
from __future__ import annotations

import math
from typing import Any

from native_pointer import TARGET_GEOMETRY, prepare_pointer_target
from native_webdriver_transport import WebDriverError

from .steps import StepError
from .steps.mouse import drag_offset


_ELEMENT = "element-6066-11e4-a52e-4f735466cecf"


def _origin(session, selector: str) -> dict[str, str]:
    return {_ELEMENT: session.find(selector, interactive=False)}


def _prepare(session, origin: dict[str, str]) -> dict[str, int]:
    # Scroll the actual element's clipping ancestors, not merely the WebView.
    # Input remains W3C pointer actions; no DOM event or drop is synthesized.
    session.request("POST", session.endpoint("/execute/sync"), {
        "script": "arguments[0].scrollIntoView({block:'nearest', inline:'nearest', behavior:'instant'});",
        "args": [origin],
    })
    return prepare_pointer_target(session, origin)


def prepare_drag_points(session, args: dict[str, Any]) -> tuple[tuple[int, int], tuple[int, int], int]:
    offset = drag_offset(args)
    if offset is not None and any(not math.isfinite(value) for value in offset[:2]):
        raise StepError("drag_to: offsets must be finite")
    try:
        source = _origin(session, args["from"])
        target = _origin(session, args["to"]) if offset is None else None
        # A tree target may need its own scroll while the file list stays put.
        # Prepare it first, then ensure preparing the source did not hide it.
        end = _prepare(session, target) if target is not None else None
        start = _prepare(session, source)
        if target is not None:
            current = session.request("POST", session.endpoint("/execute/sync"), {
                "script": TARGET_GEOMETRY, "args": [target, False],
            })
            if (not isinstance(current, dict) or current.get("ready") is not True
                    or any(current.get(key) != end[key] for key in ("x", "y"))):
                raise StepError("drag_to: target moved or became covered while preparing source; "
                                f"both endpoints must remain hit-testable: {current}")
            steps = 8
        else:
            dx, dy, steps = offset
            end = {"x": round(start["x"] + dx), "y": round(start["y"] + dy)}
        return (start["x"], start["y"]), (end["x"], end["y"]), steps
    except WebDriverError as error:
        raise StepError(f"drag_to: endpoint preparation failed: {error}") from error
