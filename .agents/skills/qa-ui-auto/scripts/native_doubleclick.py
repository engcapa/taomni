"""Stable element preparation and one trusted native double-click sequence."""
from contextlib import suppress
import time
from typing import Callable

from native_pointer import MOUSE_SOURCE, prepare_click_target
from native_webdriver_transport import WebDriverError


def double_click(session, selector: str, *, is_stale: Callable[[BaseException], bool]) -> str:
    # A one-shot /rect sample opened neighbouring Explorer files while
    # navigation/scrollbars were settling on WebView2. Resolve the actual element
    # and reuse the same stable hit-test/hover check as ordinary native clicks.
    for attempt in range(3):
        element = session.find(selector, interactive=True)
        origin = {"element-6066-11e4-a52e-4f735466cecf": element}
        try:
            session.request("POST", session.endpoint("/execute/sync"), {
                "script": "arguments[0].scrollIntoView({block:'nearest', inline:'nearest', behavior:'instant'});",
                "args": [origin],
            })
            point = prepare_click_target(session, origin)
            break
        except WebDriverError as error:
            if is_stale(error) and attempt < 2:
                time.sleep(0.3)
                continue
            raise
    # Never replay ambiguous pointer input or replace a covered target with a
    # DOM-dispatched event. The helper owns release on success and failure.
    try:
        session.request("POST", session.endpoint("/actions"), {"actions": [{
            "type": "pointer", "id": MOUSE_SOURCE, "parameters": {"pointerType": "mouse"},
            "actions": [
                {"type": "pointerMove", "duration": 0, "origin": "viewport", **point},
                {"type": "pointerDown", "button": 0},
                {"type": "pointerUp", "button": 0},
                {"type": "pause", "duration": 50},
                {"type": "pointerDown", "button": 0},
                {"type": "pointerUp", "button": 0},
            ],
        }]})
    finally:
        with suppress(WebDriverError):
            session.request("DELETE", session.endpoint("/actions"))
    return f"double-clicked {selector}"
