"""Observe real Linux window movement from a renderer's drag affordance."""
from __future__ import annotations

import json
import math
import subprocess
from contextlib import suppress

from .deadline import budget_time as time
from .steps import StepError


def command(*args: str) -> str:
    result = subprocess.run(args, capture_output=True, text=True, timeout=10, check=False)
    if result.returncode:
        raise StepError(f"native_window_drag: {args[0]} failed: {result.stderr.strip()}")
    return result.stdout


def window_geometry(window_id: str) -> dict[str, int]:
    fields = dict(line.split("=", 1) for line in command(
        "xdotool", "getwindowgeometry", "--shell", window_id,
    ).splitlines() if "=" in line)
    return {name.lower(): int(fields[name]) for name in ("X", "Y", "WIDTH", "HEIGHT")}


def validate_movement(before: dict, after: dict, dx: int, dy: int) -> None:
    actual = {axis: after[axis] - before[axis] for axis in ("x", "y")}
    if abs(actual["x"] - dx) > 4 or abs(actual["y"] - dy) > 4:
        raise StepError(f"native_window_drag: expected displacement {(dx, dy)}, observed {actual}")
    if any(after[axis] != before[axis] for axis in ("width", "height")):
        raise StepError("native_window_drag: gesture resized the window instead of moving it")


def run_window_drag(ctx, args: dict, window_id: str, identity: str) -> str:
    fraction = args.get("y_fraction", 0.5)
    dx, dy = args["dx"], args["dy"]
    if not isinstance(fraction, (int, float)) or not math.isfinite(fraction) or not 0.05 <= fraction <= 0.95:
        raise StepError("native_window_drag: y_fraction must be within 0.05..0.95")
    if any(type(value) is not int or abs(value) > 100 for value in (dx, dy)) or (dx == 0 and dy == 0):
        raise StepError("native_window_drag: dx/dy must be integers within -100..100 and specify movement")

    original = window_geometry(window_id)
    observation = {"window": window_id, "identity": identity, "transport": "X11 xdotool",
                   "selector": args["selector"], "y_fraction": fraction, "requested": {"dx": dx, "dy": dy}}
    try:
        # Give each gesture room to move without hitting a screen edge/snap zone.
        command("wmctrl", "-ir", window_id, "-e", "0,120,120,1000,680")
        time.sleep(0.3)
        before = window_geometry(window_id)
        geometry = ctx.session.execute(
            f"const el = document.querySelector({json.dumps(args['selector'])});"
            "if (!el) return null; const r = el.getBoundingClientRect();"
            "return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight};"
        )
        if not geometry or geometry["width"] <= 0 or geometry["height"] <= 0:
            raise StepError("native_window_drag: drag target has no visible area")
        x = before["x"] + round((geometry["x"] + geometry["width"] / 2) * before["width"] / geometry["viewportWidth"])
        y = before["y"] + round((geometry["y"] + geometry["height"] * fraction) * before["height"] / geometry["viewportHeight"])
        observation.update(before=before, geometry=geometry, pointer={"x": x, "y": y})
        command("xdotool", "mousemove", "--sync", str(x), str(y))
        command("xdotool", "mousedown", "1")
        time.sleep(0.2)
        for step in range(1, 6):
            command("xdotool", "mousemove", "--sync", str(x + round(dx * step / 5)), str(y + round(dy * step / 5)))
            time.sleep(0.04)
        command("xdotool", "mouseup", "1")
        time.sleep(0.2)
        after = window_geometry(window_id)
        observation["after"] = after
        validate_movement(before, after, dx, dy)
        observation["passed"] = True
    except Exception as exc:
        observation.update(passed=False, error=str(exc))
        raise
    finally:
        with suppress(Exception):
            command("xdotool", "mouseup", "1")
        with suppress(Exception):
            command("wmctrl", "-ir", window_id, "-e", f"0,{original['x']},{original['y']},{original['width']},{original['height']}")
        with (ctx.case_dir / "native-window-drags.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation, ensure_ascii=False) + "\n")
    return f"native window moved by ({dx}, {dy}) from y={fraction}"


def run_wayland_window_drag(ctx, args: dict) -> str:
    from .wayland import command as desktop_command

    fraction = args.get("y_fraction", 0.5)
    dx, dy = args["dx"], args["dy"]
    if not isinstance(fraction, (int, float)) or not math.isfinite(fraction) or not 0.05 <= fraction <= 0.95:
        raise StepError("native_window_drag: y_fraction must be within 0.05..0.95")
    if any(type(value) is not int or abs(value) > 100 for value in (dx, dy)) or (dx == 0 and dy == 0):
        raise StepError("native_window_drag: dx/dy must specify movement within -100..100")
    application = str(ctx.session.application)
    ctx.session.activate_wayland_window()
    original = desktop_command("geometry", application=application)["frame"]
    observation = {"transport": "Mutter RemoteDesktop pointer -> GNOME window manager",
                   "application": application, "selector": args["selector"], "requested": {"dx": dx, "dy": dy}}
    try:
        desktop_command("place", application=application, rect={"x": 120, "y": 120, "width": 1000, "height": 680})
        time.sleep(0.3)
        before = desktop_command("geometry", application=application)["frame"]
        geometry = ctx.session.execute(
            f"const el=document.querySelector({json.dumps(args['selector'])});"
            "if(!el)return null; const r=el.getBoundingClientRect();"
            "return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight};")
        if not geometry or geometry["width"] <= 0 or geometry["height"] <= 0:
            raise StepError("native_window_drag: drag target has no visible area")
        x = before["x"] + round((geometry["x"] + geometry["width"] / 2) * before["width"] / geometry["viewportWidth"])
        y = before["y"] + round((geometry["y"] + geometry["height"] * fraction) * before["height"] / geometry["viewportHeight"])
        observation.update(before=before, geometry=geometry, pointer={"x": x, "y": y})
        desktop_command("drag", start=[x, y], end=[x + dx, y + dy])
        time.sleep(0.2)
        after = desktop_command("geometry", application=application)["frame"]
        observation["after"] = after
        validate_movement(before, after, dx, dy)
        observation["passed"] = True
    except Exception as error:
        observation.update(passed=False, error=str(error))
        raise
    finally:
        with suppress(Exception):
            desktop_command("place", application=application, rect=original)
        with (ctx.case_dir / "native-window-drags.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation, ensure_ascii=False) + "\n")
    return f"Wayland native window moved by ({dx}, {dy}) from y={fraction}"
