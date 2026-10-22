"""Resolve a stable, hit-testable viewport point before native pointer input."""
import math
import time

from native_webdriver_transport import WebDriverError


TARGET_GEOMETRY = r"""
const el = arguments[0];
if (!el?.isConnected) throw new Error('stale element reference');
const r = el.getBoundingClientRect();
const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
const x = Math.floor((left + right) / 2), y = Math.floor((top + bottom) / 2);
const hit = document.elementFromPoint(x, y);
return {x, y, width: r.width, height: r.height,
        ready: right > left && bottom > top && !!hit && el.contains(hit)};
"""


def prepare_pointer_target(session, origin: dict, timeout: float = 5.0) -> dict:
    """Wait for two matching points; never activate a target or replay input.

    Element-origin actions leave geometry resolution to the driver. Resolve
    against the current viewport explicitly so a row changing after a save
    must first settle and pass the same DOM hit test as a physical pointer.
    The caller still sends trusted W3C input, and assertions remain unchanged.
    """
    end = time.monotonic() + timeout
    previous = None
    last = None
    while True:
        if session.deadline:
            session.deadline.remaining()
        last = session.request("POST", session.endpoint("/execute/sync"), {
            "script": TARGET_GEOMETRY, "args": [origin],
        })
        if (not isinstance(last, dict) or not isinstance(last.get("ready"), bool)
                or any(isinstance(last.get(k), bool) or not isinstance(last.get(k), (int, float))
                       or not math.isfinite(last[k]) for k in ("x", "y", "width", "height"))):
            raise WebDriverError("invalid native pointer target geometry")
        current = tuple(last[k] for k in ("x", "y", "width", "height")) if last["ready"] else None
        if current is not None and current == previous:
            return {"x": int(last["x"]), "y": int(last["y"])}
        previous = current
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise WebDriverError(f"native pointer target did not become stable and hit-testable: {last}")
        if session.deadline:
            remaining = min(remaining, session.deadline.remaining())
        time.sleep(min(0.05, remaining))
