"""Resolve a stable, hit-testable viewport point before native pointer input."""
import math
import time
from contextlib import suppress

from native_webdriver_transport import WebDriverError

MOUSE_SOURCE = "mouse"


def click_viewport_point(session, x: int, y: int, *, move_ms: int = 0,
                         hold_ms: int = 0) -> None:
    """Use the same physical mouse source as locator clicks, and always release.

    A separate source for a remote canvas leaves two W3C mouse positions when
    the next action operates the local toolbar. Keep one source across that
    boundary; never replay an ambiguous input failure.
    """
    actions = [{"type": "pointerMove", "duration": move_ms,
                "x": x, "y": y, "origin": "viewport"},
               {"type": "pointerDown", "button": 0}]
    if hold_ms:
        actions.append({"type": "pause", "duration": hold_ms})
    actions.append({"type": "pointerUp", "button": 0})
    try:
        session.request("POST", session.endpoint("/actions"), {"actions": [{
            "type": "pointer", "id": MOUSE_SOURCE,
            "parameters": {"pointerType": "mouse"}, "actions": actions,
        }]})
    finally:
        with suppress(WebDriverError):
            session.request("DELETE", session.endpoint("/actions"))


TARGET_GEOMETRY = r"""
const el = arguments[0];
if (!el?.isConnected) throw new Error('stale element reference');
const r = el.getBoundingClientRect();
const allowAlternate = arguments[1];
const probe = r => {
  const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
  const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
  const x = Math.floor((left + right) / 2), y = Math.floor((top + bottom) / 2);
  const points = [[x, y]];
  if (allowAlternate && right > left && bottom > top) {
    // A context menu may intentionally stay open while applying terminal
    // appearance settings. Right-click another visible part of that same
    // container to reopen it; never click through a covering sibling/portal.
    const inset = Math.min(8, (right - left) / 4, (bottom - top) / 4);
    const l = Math.ceil(left + inset), rr = Math.floor(right - inset);
    const t = Math.ceil(top + inset), b = Math.floor(bottom - inset);
    points.push([l,y], [rr,y], [x,t], [x,b], [l,t], [rr,t], [l,b], [rr,b]);
  }
  for (const [px, py] of points) {
    const hit = document.elementFromPoint(px, py);
    if (right > left && bottom > top && !!hit && el.contains(hit)) {
      return {x: px, y: py, width: r.width, height: r.height, ready: true};
    }
  }
  return {x, y, width: r.width, height: r.height, ready: false,
    outside: right <= left || bottom <= top};
};
const original = probe(r);
if (original.ready || !el.closest('dialog:modal')) return original;
// WKWebView can report a top-layer dialog's rect divided by an ancestor's
// CSS zoom, while elementFromPoint uses viewport coordinates. Correct only
// that geometry and still require the original element to pass the hit test.
let zoom = 1;
for (let node = el; node; node = node.parentElement) {
  zoom *= Number.parseFloat(getComputedStyle(node).zoom) || 1;
}
if (zoom !== 1 && Number.isFinite(zoom) && zoom > 0) {
  const corrected = probe({left:r.left*zoom, right:r.right*zoom,
    top:r.top*zoom, bottom:r.bottom*zoom, width:r.width*zoom, height:r.height*zoom});
  if (corrected.ready) return corrected;
}
return original;
"""


def prepare_pointer_target(session, origin: dict, timeout: float = 5.0,
                           *, allow_alternate: bool = False) -> dict:
    """Wait for two matching points; never activate a target or replay input.

    Element-origin actions leave geometry resolution to the driver. Resolve
    against the current viewport explicitly so a row changing after a save
    must first settle and pass the same DOM hit test as a physical pointer.
    The caller still sends trusted W3C input, and assertions remain unchanged.
    """
    end = time.monotonic() + timeout
    previous = None
    last = None
    centered = False
    while True:
        if session.deadline:
            session.deadline.remaining()
        last = session.request("POST", session.endpoint("/execute/sync"), {
            "script": TARGET_GEOMETRY, "args": [origin, allow_alternate],
        })
        if (not isinstance(last, dict) or not isinstance(last.get("ready"), bool)
                or any(isinstance(last.get(k), bool) or not isinstance(last.get(k), (int, float))
                       or not math.isfinite(last[k]) for k in ("x", "y", "width", "height"))):
            raise WebDriverError("invalid native pointer target geometry")
        current = tuple(last[k] for k in ("x", "y", "width", "height")) if last["ready"] else None
        if current is not None and current == previous:
            return {"x": int(last["x"]), "y": int(last["y"])}
        previous = current
        if not last["ready"] and (last.get("outside") is True or not centered):
            # Nearest alignment can leave a control behind a sticky header or
            # a clipping ancestor despite being inside the viewport. Center
            # once, then require the same hit test. Layout growth can also
            # move it outside again; no input has been sent at this stage.
            centered = True
            session.request("POST", session.endpoint("/execute/sync"), {
                "script": "arguments[0].scrollIntoView({block:'center', inline:'center'});",
                "args": [origin],
            })
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise WebDriverError(f"native pointer target did not become stable and hit-testable: {last}")
        if session.deadline:
            remaining = min(remaining, session.deadline.remaining())
        time.sleep(min(0.05, remaining))
