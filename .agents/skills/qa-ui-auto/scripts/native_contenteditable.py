"""Real keyboard replacement for native contenteditable owners such as CM6."""
from __future__ import annotations

import json
import time
from typing import Protocol, Any


class EditorInputSession(Protocol):
    def request(self, method: str, path: str, payload: dict) -> Any: ...
    def element_path(self, element: str, suffix: str) -> str: ...
    def execute(self, script: str) -> Any: ...
    def press_combo(self, combo: str) -> str: ...
    def type_text(self, text: str) -> str: ...


def fill_contenteditable(session: EditorInputSession, element: str, selector: str,
                         text: str, error_type: type[Exception]) -> str:
    # WebKit /value accepts contenteditable without the beforeinput/input
    # transactions CM owns. Use actual keys, retaining the normal input pacing.
    def focused() -> bool:
        return session.execute(
            f"const el = document.querySelector({json.dumps(selector)});"
            "return !!el && document.activeElement === el;"
        ) is True

    # Opening an editor normally focuses it. Retain that owner instead of
    # adding another pointer action and WebView round trip before real keys.
    if not focused():
        for _ in range(3):
            session.request("POST", session.element_path(element, "/click"), {})
            if focused():
                break
            time.sleep(.1)
        else:
            raise error_type(f"contenteditable did not receive focus: {selector}")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")

    def replace_with_keys() -> None:
        # CodeMirror uses Cmd+A on macOS. Ctrl+A moves to the start of the line,
        # which leaves old text in place instead of replacing the document.
        session.press_combo("Mod+a")
        if not normalized:
            session.press_combo("Backspace")
        else:
            for index, line in enumerate(normalized.split("\n")):
                if index:
                    session.press_combo("Enter")
                if line:
                    session.type_text(line)

    # A WebKit contenteditable can commit the selection before the final CM6
    # line is selected. Verify the real editor text and retry the same trusted
    # keyboard replacement once rather than allowing a stale suffix (for
    # example a duplicate </svg>) to reach the product.
    for attempt in range(2):
        replace_with_keys()
        actual = session.execute(
            f"const el = document.querySelector({json.dumps(selector)});"
            "return el ? el.innerText.replace(/\\r\\n?/g, '\\n') : null;"
        )
        if actual == normalized:
            return f"filled contenteditable {selector}"
        if attempt == 1:
            raise error_type(f"contenteditable did not retain the requested text: {selector}")
    return f"filled contenteditable {selector}"
