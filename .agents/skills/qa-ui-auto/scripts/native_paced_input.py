"""One sequential W3C input owner with the same pacing on all native WebViews."""
from __future__ import annotations

from typing import Any, Protocol

from native_webdriver_transport import WebDriverError


class PacedInputSession(Protocol):
    MODIFIER_MAP: dict[str, str]

    def endpoint(self, suffix: str) -> str: ...
    def request(self, method: str, path: str, payload: dict | None = None) -> Any: ...


def type_paced_text(session: PacedInputSession, text: str) -> str:
    if not text:
        return "typed 0 chars"
    actions: list[dict[str, Any]] = []
    for character in text:
        if character.isupper():
            shift = session.MODIFIER_MAP["Shift"]
            actions.append({"type": "keyDown", "value": shift})
            actions.append({"type": "keyDown", "value": character})
            actions.append({"type": "keyUp", "value": character})
            actions.append({"type": "keyUp", "value": shift})
        else:
            actions.append({"type": "keyDown", "value": character})
            actions.append({"type": "keyUp", "value": character})
        # The macOS bridge now awaits each tick's duration, like the system
        # WebDrivers. These pauses allow input observers and rendered frames
        # between keys without spending one HTTP round trip per character.
        actions.append({"type": "pause", "duration": 20})
    try:
        session.request("POST", session.endpoint("/actions"), {
            "actions": [{"type": "key", "id": "keyboard", "actions": actions}],
        })
    finally:
        # Delivery may be uncertain after an error. Release, never replay.
        try:
            session.request("DELETE", session.endpoint("/actions"))
        except WebDriverError:
            pass
    return f"typed {len(text)} chars"
