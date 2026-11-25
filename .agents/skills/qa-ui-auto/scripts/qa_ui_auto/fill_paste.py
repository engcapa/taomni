"""Explicit whole-source paste, using the clipboard and normal editor input path."""
from __future__ import annotations

import hashlib
import json
import platform

from .steps import StepError


def requested(args: dict) -> bool:
    method = args.get("method")
    if method is None:
        return False
    if method != "paste":
        raise StepError("fill: method must be paste when specified")
    if not isinstance(args.get("selector"), str) or not args["selector"]:
        raise StepError("fill with method paste: selector must be a non-empty string")
    if not isinstance(args.get("value"), str) or not args["value"]:
        raise StepError("fill with method paste: value must be a non-empty string; use normal fill to clear")
    return True


def browser(ctx, selector: str, text: str) -> None:
    if ctx.dry_run:
        return
    loc = ctx.page.locator(selector).first
    loc.focus()
    loc.press("ControlOrMeta+a")
    observed = ctx.page.evaluate("""async (text) => {
      await navigator.clipboard.writeText(text);
      return await navigator.clipboard.readText();
    }""", text)
    # Chromium serializes text/plain to Windows clipboard CRLF. Keep all
    # characters and whitespace; the case still asserts exact editor/disk LF.
    windows_text = text.replace("\r\n", "\n").replace("\n", "\r\n") if platform.system() == "Windows" else text
    if observed != text and observed != windows_text:
        raise StepError("fill with method paste: browser clipboard read-back differs from the requested text")
    loc.press("ControlOrMeta+v")


def native(ctx, selector: str, text: str) -> str:
    if getattr(ctx, "dry_run", False):
        return "dry-run; no clipboard write or OS Paste"
    from . import host_clipboard, native_paste

    observation = {"selector": selector, "method": "paste", "passed": False,
                   "bytes": len(text.encode("utf-8")),
                   "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                   "clipboardRetained": False, "syntheticClipboardEvent": False}
    try:
        ctx.session.focus(selector)
        ctx.session.press_combo("Mod+a")
        host_clipboard.set_text(text)
        # Keep the fixture on the isolated runner clipboard. Restoring it
        # immediately could race the asynchronous WebView OS paste request.
        observation["clipboardRetained"] = True
        if host_clipboard.get_text() != text:
            raise StepError("fill with method paste: OS clipboard read-back differs from the requested text")
        native_paste.run(ctx, {"selector": selector})
        observation["passed"] = True
        return "Whole-source replacement sent through one real OS Paste; case verifies editor/disk contents"
    except Exception as error:
        observation["error"] = str(error)
        raise
    finally:
        with (ctx.case_dir / "fill-paste.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation) + "\n")
