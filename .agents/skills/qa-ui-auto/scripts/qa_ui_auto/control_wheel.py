"""Send a real Control+wheel gesture to the visible QA view."""
import os
import platform
import subprocess

from .steps import StepError


def validate(args):
    if not isinstance(args, dict) or set(args) != {"selector", "direction"} or args["direction"] not in ("up", "down"):
        raise StepError("control_wheel expects a selector and an up or down direction")


def browser(ctx, args):
    validate(args)
    if ctx.dry_run:
        return
    ctx.page.locator(args["selector"]).hover()
    ctx.page.keyboard.down("Control")
    try:
        ctx.page.mouse.wheel(0, -100 if args["direction"] == "up" else 100)
    finally:
        ctx.page.keyboard.up("Control")


def native(ctx, args):
    validate(args)
    if getattr(ctx, "dry_run", False):
        return "dry-run"
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("control_wheel requires an isolated X11 display for native input")
    ctx.session.activate_linux_window()
    element = ctx.session.find(args["selector"], interactive=True)
    ctx.session.request("POST", ctx.session.endpoint("/actions"), {"actions": [{
        "type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"},
        "actions": [{"type": "pointerMove", "duration": 150, "x": 0, "y": 0,
                     "origin": {"element-6066-11e4-a52e-4f735466cecf": element}}],
    }]})
    try:
        subprocess.run(["xdotool", "keydown", "Control_L", "click", "4" if args["direction"] == "up" else "5"],
                       check=True, timeout=5)
    finally:
        subprocess.run(["xdotool", "keyup", "Control_L"], check=True, timeout=5)
    return f"sent X11 Control+wheel {args['direction']}"
