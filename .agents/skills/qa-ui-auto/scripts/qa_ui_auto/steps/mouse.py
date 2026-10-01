"""Mouse interactions: click variants, hover, drag."""

from __future__ import annotations

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


def mouse_path_points(args: Any) -> list[dict[str, Any]]:
    """Validate `mouse_path: {points: [{selector, dx?, dy?, steps?, pause_ms?}]}`.

    dx/dy are CSS-pixel offsets from the element's centre (the W3C element
    origin used by the native runner too); `steps` interpolates intermediate
    moves; `pause_ms` rests after reaching the point.
    """
    points = args.get("points") if isinstance(args, dict) else None
    if not isinstance(points, list) or not points:
        raise StepError("mouse_path: expected {points: [{selector, dx?, dy?, steps?, pause_ms?}, ...]}")
    out: list[dict[str, Any]] = []
    for point in points:
        if not isinstance(point, dict) or not isinstance(point.get("selector"), str):
            raise StepError(f"mouse_path: every point needs a selector, got {point!r}")
        out.append({
            "selector": point["selector"],
            "dx": float(point.get("dx", 0)),
            "dy": float(point.get("dy", 0)),
            "steps": max(1, int(point.get("steps", 1))),
            "pause_ms": max(0, int(point.get("pause_ms", 0))),
        })
    return out


@verb("mouse_path")
def step_mouse_path(ctx: StepContext, args: Any) -> None:
    """Move the pointer through element-relative points without clicking."""
    points = mouse_path_points(args)
    if ctx.dry_run:
        return
    page = ctx.page  # type: ignore[attr-defined]
    for point in points:
        box = page.locator(point["selector"]).first.bounding_box()
        if not box:
            raise StepError(f"mouse_path: {point['selector']} has no layout box")
        x = box["x"] + box["width"] / 2 + point["dx"]
        y = box["y"] + box["height"] / 2 + point["dy"]
        page.mouse.move(x, y, steps=point["steps"])
        if point["pause_ms"]:
            page.wait_for_timeout(point["pause_ms"])


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
    src.drag_to(dst, force=True)
