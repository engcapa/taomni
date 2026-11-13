"""One-request native drags: pointer state never crosses a macOS bridge request."""

from __future__ import annotations

from contextlib import suppress
import json
import math
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from .steps import StepError
from .steps.mouse import drag_modifiers, drag_offset


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
        "return r ? {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight} : null;"
    )
    if (not isinstance(box, dict) or any(not isinstance(box.get(k), (int, float))
            or not math.isfinite(box[k]) for k in ("x", "y", "width", "height"))
            or box["width"] <= 0 or box["height"] <= 0):
        raise StepError(f"drag_to: {selector} has no layout box")
    x, y = round(box["x"] + box["width"] / 2), round(box["y"] + box["height"] / 2)
    if (isinstance(box.get("viewportWidth"), (int, float)) and isinstance(box.get("viewportHeight"), (int, float))
            and not (0 <= x < box["viewportWidth"] and 0 <= y < box["viewportHeight"])):
        raise StepError(f"drag_to: {selector} target centre is outside the WebView viewport")
    return x, y


def _start_dom_trace(session: DragSession, key: str) -> None:
    session.execute("""
const key = __KEY__;
const types = ['pointerdown','pointermove','pointerup','pointercancel',
  'mousedown','mousemove','mouseup','click','dragstart','dragover','drop','dragend','blur','focus'];
const state = {events: [], dropped: 0};
const describe = (target) => {
  if (target === window) return {tag: 'WINDOW'};
  if (target === document) return {tag: 'DOCUMENT'};
  if (!(target instanceof Element)) return null;
  const path = target.closest('[data-path],[data-explorer-drop]');
  const control = target.closest('[data-testid]');
  return {tag: target.tagName, testId: control?.getAttribute('data-testid') ?? null,
    path: path?.getAttribute('data-path') ?? path?.getAttribute('data-explorer-drop') ?? null};
};
const record = (event) => {
  if (state.events.length >= 2048) { state.dropped++; return; }
  state.events.push({type: event.type, time: performance.now(), target: describe(event.target),
    activeElement: describe(document.activeElement), defaultPrevented: event.defaultPrevented,
    button: event.button ?? null, buttons: event.buttons ?? null,
    pointerId: event.pointerId ?? null, pointerType: event.pointerType ?? null,
    clientX: event.clientX ?? null, clientY: event.clientY ?? null,
    altKey: !!event.altKey, ctrlKey: !!event.ctrlKey,
    shiftKey: !!event.shiftKey, metaKey: !!event.metaKey, isTrusted: event.isTrusted});
};
const options = {capture: true, passive: true};
state.stop = () => { for (const type of types) window.removeEventListener(type, record, options); };
window[key] = state;
for (const type of types) window.addEventListener(type, record, options);
return true;
""".replace("__KEY__", json.dumps(key)))


def _finish_dom_trace(session: DragSession, key: str) -> dict[str, Any]:
    value = session.execute("""
const key = __KEY__;
const state = window[key];
if (!state) return {events: [], missing: true};
try { return {events: state.events, dropped: state.dropped}; }
finally { state.stop(); delete window[key]; }
""".replace("__KEY__", json.dumps(key)))
    if not isinstance(value, dict) or not isinstance(value.get("events"), list):
        raise ValueError("native drag DOM observation returned an invalid payload")
    return value


def _append_drag_receipt(ctx: DragContext, value: dict[str, Any]) -> None:
    with (ctx.case_dir / "native-drags.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value) + "\n")


def native_drag(ctx: DragContext, args: Any) -> str:
    if not isinstance(args, dict) or "from" not in args:
        raise StepError("drag_to: expected {from, to|by}")
    if "from_position" in args or "to_position" in args:
        raise StepError("drag_to: element-relative explicit positions are browser-only")
    modifiers = drag_modifiers(args)
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
    trace_id = f"__taomniQaDragObservation_{uuid4().hex}"
    _append_drag_receipt(ctx, {"args": args, "start": start, "end": end, "actions": actions, "traceId": trace_id})
    sources = [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": actions}]
    if modifiers:
        keys = {"Control": "", "Alt": "", "Meta": "", "Shift": ""}
        paused = [{"type": "pause", "duration": 0} for _ in modifiers]
        sources[0]["actions"] = paused + actions + paused
        sources.append({"type": "key", "id": "drag-modifiers", "actions": [
            *[{"type": "keyDown", "value": keys[key]} for key in modifiers],
            *[{"type": "pause", "duration": 0} for _ in actions],
            *[{"type": "keyUp", "value": keys[key]} for key in reversed(modifiers)],
        ]})
    diagnostics: dict[str, Any] = {"kind": "dom-events", "traceId": trace_id, "events": []}
    try:
        _start_dom_trace(ctx.session, trace_id)
    except Exception as error:
        diagnostics["setupError"] = str(error)
    try:
        ctx.session.request("POST", ctx.session.endpoint("/actions"), {"actions": sources})
    finally:
        with suppress(Exception):
            ctx.session.request("DELETE", ctx.session.endpoint("/actions"))
        try:
            diagnostics.update(_finish_dom_trace(ctx.session, trace_id))
        except Exception as error:
            diagnostics["collectionError"] = str(error)
        # Observation must never replace the transport's original exception.
        with suppress(Exception):
            _append_drag_receipt(ctx, diagnostics)
    return f"dragged {start} -> {end} in {steps} moves"
