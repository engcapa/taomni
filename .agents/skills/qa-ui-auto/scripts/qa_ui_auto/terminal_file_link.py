"""Trusted modifier-click at the real terminal's passive search-highlight geometry."""
from __future__ import annotations

import json
import platform

from .steps import StepError


def validate(args):
    if not isinstance(args, dict) or set(args) != {"selector"} or not isinstance(args["selector"], str) or not args["selector"]:
        raise StepError("terminal_file_link: expected selector with one active terminal search hit")
    return args["selector"]


GEOMETRY = """const pane=document.querySelector(arguments[0]);const hit=pane?.querySelector('.terminal-search-hit-active');
if(!hit)return null;const rect=hit.getBoundingClientRect();const screen=pane.querySelector('.xterm-screen');
if(!screen || rect.width<=0 || rect.height<=0)return null;const target=screen.getBoundingClientRect();
const x=rect.left+Math.min(rect.width/2,24), y=rect.top+rect.height/2;
const park=[[target.left+8,target.bottom-8],[target.right-8,target.bottom-8],[target.left+8,target.top+8]].find(([cx,cy])=>Math.hypot(cx-x,cy-y)>24 && screen.contains(document.elementFromPoint(cx,cy))) || null;
return {x,y,parkX:park?park[0]:null,parkY:park?park[1]:null,width:target.width,height:target.height,hit:screen.contains(document.elementFromPoint(x,y))};"""


def run(ctx, args, mode):
    selector = validate(args)
    if getattr(ctx, "dry_run", False):
        return "dry-run; no terminal file link activation"
    observation = {"mode": mode, "selector": selector, "trustedPointer": True, "passed": False}
    if mode == "native":
        point = ctx.session.execute(GEOMETRY.replace("arguments[0]", json.dumps(selector)))
    else:
        point = ctx.page.evaluate("(selector)=>{" + GEOMETRY.replace("arguments[0]", "selector") + "}", selector)
    if not point or not point.get("hit"):
        raise StepError("terminal_file_link: no active visible hit-testable search hit")
    observation["point"] = point
    modifier = "Meta" if platform.system() == "Darwin" else "Control"
    try:
        # Search selects terminal text; hover/move must let xterm's link provider
        # resolve the path before the one click. Never replay that click.
        # Move off-cell inside .xterm-screen first because xterm's mouseleave
        # clears _currentLink without clearing _lastBufferCell.
        from .deadline import budget_time as time
        if mode == "browser":
            if point.get("parkX") is not None and point.get("parkY") is not None:
                ctx.page.mouse.move(point["parkX"], point["parkY"])
                time.sleep(.05)
            ctx.page.mouse.move(point["x"], point["y"])
            time.sleep(.2)
        else:
            if point.get("parkX") is not None and point.get("parkY") is not None:
                ctx.session.request("POST", ctx.session.endpoint("/actions"), {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [{"type": "pointerMove", "origin": "viewport", "x": round(point["parkX"]), "y": round(point["parkY"]), "duration": 0}]}]})
                time.sleep(.05)
            ctx.session.request("POST", ctx.session.endpoint("/actions"), {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [{"type": "pointerMove", "origin": "viewport", "x": round(point["x"]), "y": round(point["y"]), "duration": 0}]}]})
            time.sleep(.2)
        if mode == "browser":
            ctx.page.keyboard.down(modifier)
            try:
                ctx.page.mouse.move(point["x"], point["y"])
                ctx.page.mouse.click(point["x"], point["y"])
            finally:
                ctx.page.keyboard.up(modifier)
        else:
            key = "" if modifier == "Meta" else ""
            from contextlib import suppress
            from native_webdriver_transport import WebDriverError
            actions = [
                {"type": "key", "id": "terminal-link-key", "actions": [{"type": "keyDown", "value": key}, {"type": "pause", "duration": 0}, {"type": "pause", "duration": 0}, {"type": "pause", "duration": 0}, {"type": "keyUp", "value": key}]},
                {"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
                    {"type": "pause", "duration": 0},
                    {"type": "pointerMove", "origin": "viewport", "x": round(point["x"]), "y": round(point["y"]), "duration": 0},
                    {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}, {"type": "pause", "duration": 0}]},
            ]
            try:
                ctx.session.request("POST", ctx.session.endpoint("/actions"), {"actions": actions})
            finally:
                with suppress(WebDriverError):
                    ctx.session.request("DELETE", ctx.session.endpoint("/actions"))
        observation["passed"] = True
        return "Real terminal modifier-click delivered; testcase owns local-open/SSH refusal result"
    except Exception as error:
        observation["error"] = str(error)
        raise
    finally:
        with (ctx.case_dir / "terminal-file-link-clicks.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation) + "\n")


def browser(ctx, args):
    return run(ctx, args, "browser")


def native(ctx, args):
    return run(ctx, args, "native")
