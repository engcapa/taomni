"""Mouse interactions: click variants, hover, drag."""

from __future__ import annotations

import math
import platform
from typing import Any

from . import StepContext, StepError, verb


def _resolve_click(args: Any) -> tuple[str, dict[str, Any]]:
    if isinstance(args, str):
        return args, {}
    if isinstance(args, dict):
        sel = args["selector"]
        kwargs: dict[str, Any] = {}
        if "modifiers" in args:
            # Platform Command-Mod (mirrors the `press` verb): on macOS a
            # Control+click is delivered as a right-click by the OS/Chromium
            # convention, so `Mod` selects Meta there and Control elsewhere.
            is_mac = platform.system() == "Darwin"
            kwargs["modifiers"] = [
                ("Meta" if (str(m).lower() == "mod" and is_mac)
                 else "Control" if str(m).lower() == "mod" else m)
                for m in args["modifiers"]
            ]
        if "force" in args:
            kwargs["force"] = bool(args["force"])
        if "position" in args:
            kwargs["position"] = {"x": args["position"]["x"], "y": args["position"]["y"]}
        return sel, kwargs
    raise StepError(f"click arg must be string or object, got {type(args).__name__}")


@verb("click")
def step_click(ctx: StepContext, args: Any) -> None:
    selector, kwargs = _resolve_click(args)
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.click(**kwargs)


@verb("dblclick")
def step_dblclick(ctx: StepContext, args: Any) -> None:
    selector, kwargs = _resolve_click(args)
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.dblclick(**kwargs)


@verb("right_click")
def step_right_click(ctx: StepContext, args: Any) -> None:
    selector, kwargs = _resolve_click(args)
    kwargs["button"] = "right"
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.click(**kwargs)


@verb("hover")
def step_hover(ctx: StepContext, args: Any) -> None:
    selector = args if isinstance(args, str) else args["selector"]
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.hover()


@verb("middle_click")
def step_middle_click(ctx: StepContext, args: Any) -> None:
    selector = args if isinstance(args, str) else args["selector"]
    if not ctx.dry_run:
        ctx.page.locator(selector).first.click(button="middle")


@verb("drag_to")
def step_drag_to(ctx: StepContext, args: Any) -> None:
    src = ctx.page.locator(args["from"]).first  # type: ignore[attr-defined]
    dst = ctx.page.locator(args["to"]).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    kwargs: dict = {"force": True}
    # Optional pixel offsets within the elements (e.g. drag across a canvas
    # or screenshot image). Playwright option names are source_position /
    # target_position; the YAML uses from_position / to_position.
    if args.get("from_position"):
        kwargs["source_position"] = args["from_position"]
    if args.get("to_position"):
        kwargs["target_position"] = args["to_position"]
    src.drag_to(dst, **kwargs)


@verb("drag_path")
def step_drag_path(ctx: StepContext, args: Any) -> None:
    """Trace element-relative points with real browser pointer input, always releasing."""
    if not isinstance(args, dict) or set(args) != {"selector", "points"}:
        raise StepError("drag_path requires selector and points")
    points = args["points"]
    if not isinstance(points, list) or not 2 <= len(points) <= 256:
        raise StepError("drag_path requires 2..256 points")
    for p in points:
        if (not isinstance(p, dict) or set(p) != {"x", "y"}
                or any(isinstance(p[k], bool) or not isinstance(p[k], (int, float))
                       or not math.isfinite(p[k]) for k in ("x", "y"))):
            raise StepError("drag_path requires finite x/y coordinates")
    if ctx.dry_run:
        return
    box = ctx.page.locator(args["selector"]).first.bounding_box()
    if not box:
        raise StepError("drag_path element has no visible bounding box")
    if any(not 0 <= p["x"] <= box["width"] or not 0 <= p["y"] <= box["height"] for p in points):
        raise StepError("drag_path point is outside the selected element")
    mouse = ctx.page.mouse
    mouse.move(box["x"] + points[0]["x"], box["y"] + points[0]["y"])
    mouse.down()
    try:
        for p in points[1:]:
            mouse.move(box["x"] + p["x"], box["y"] + p["y"], steps=8)
    finally:
        mouse.up()
