"""Keyboard input: fill, type, composition, press, select_option, upload_file."""

from __future__ import annotations

import platform
import re
import time
from contextlib import suppress
from typing import Any

from . import StepContext, StepError, verb


@verb("keyboard_sequence")
def step_keyboard_sequence(ctx: StepContext, args: Any) -> None:
    """Real browser key events with modifiers held across multiple chords."""
    if not isinstance(args, list) or not args or len(args) > 32:
        raise StepError("keyboard_sequence: expected 1–32 down/up/press steps")
    for step in args:
        if not isinstance(step, dict) or len(step) != 1 or next(iter(step)) not in {"down", "up", "press"}:
            raise StepError("keyboard_sequence: expected {down|up|press: key}")
        if not isinstance(next(iter(step.values())), str) or not next(iter(step.values())).strip():
            raise StepError("keyboard_sequence: key must not be empty")
    if ctx.dry_run:
        return
    held = []
    try:
        for step in args:
            action, key = next(iter(step.items()))
            # Mark down before dispatch: release even if an injected failure
            # happens after the browser accepted the physical key event.
            if action == "down" and key not in held:
                held.append(key)
            getattr(ctx.page.keyboard, action)(key)
            if action == "up" and key in held:
                held.remove(key)
    finally:
        for key in reversed(held):
            with suppress(Exception):
                ctx.page.keyboard.up(key)


@verb("fill")
def step_fill(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("fill: expected {selector, value}")
    selector = args["selector"]
    value = args["value"]
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    if loc.get_attribute("type") == "color":
        if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            raise StepError("fill: color input requires a six-digit HEX value")
        # Playwright cannot type into a color well. Apply the selected value
        # through its native setter and normal input/change events; this is
        # renderer input, not evidence of operating the OS color chooser.
        loc.evaluate("""(el, value) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }""", value)
        return
    loc.fill(value)


@verb("type")
def step_type(ctx: StepContext, args: Any) -> None:
    selector, text = _typing_args("type", args)
    if ctx.dry_run:
        return
    if selector:
        ctx.page.locator(selector).first.focus()  # type: ignore[attr-defined]
    ctx.page.keyboard.type(text)  # type: ignore[attr-defined]


@verb("send_keys")
def step_send_keys(ctx: StepContext, args: Any) -> None:
    selector, text = _typing_args("send_keys", args)
    if ctx.dry_run:
        return
    if selector:
        ctx.page.locator(selector).first.focus()  # type: ignore[attr-defined]
    ctx.page.keyboard.type(text)  # type: ignore[attr-defined]


@verb("terminal_input")
def step_terminal_input(ctx: StepContext, args: Any) -> None:
    selector, text, submit, verify = _terminal_input_args(args)
    if ctx.dry_run:
        return
    attempts = verify["attempts"] if verify else 1
    for attempt in range(attempts):
        if attempt:
            # A truncated probe may leave an unfinished shell line or start
            # a program such as `pr` that reads stdin. Restore the prompt
            # before retrying so the next probe cannot append to that input.
            locator = ctx.page.locator(selector).first
            locator.press("Control+c")
            locator.press("Control+u")
        _dispatch_terminal_input(ctx, selector, text, submit)
        if verify is None:
            return
        if _terminal_output_matches(ctx, verify):
            return
    raise StepError(
        f"terminal_input: {verify['selector']} did not match {verify['regex']!r} "
        f"after {attempts} attempt(s)"
    )


def _dispatch_terminal_input(ctx: StepContext, selector: str, text: str, submit: bool) -> None:
    # A real modifier key cycle clears xterm's prior keypress suppression
    # state without inserting text. Send Enter separately from the text chunk.
    ctx.page.locator(selector).first.press("Shift")
    focused = ctx.page.locator(selector).first.evaluate(  # type: ignore[attr-defined]
        """(element, payload) => {
          element.focus();
          const data = payload.text;
          element.dispatchEvent(new InputEvent("input", {
            data,
            inputType: "insertText",
            bubbles: true,
            composed: false,
          }));
          return document.activeElement === element;
        }""",
        {"text": text, "submit": submit},
    )
    if focused is not True:
        raise StepError(f"terminal_input: target could not receive focus: {selector}")
    if submit:
        ctx.page.locator(selector).first.press("Enter")


def _terminal_output_matches(ctx: StepContext, verify: dict[str, Any]) -> bool:
    """Poll the pty buffer until the probe's own output shows up.

    Windows OpenSSH/ConPTY intermittently drops part of a terminal write (a
    missing leading byte, a truncated burst). An optional verify block lets the
    probe be re-sent instead of failing the case on that transport hiccup; the
    case's own assertion still decides what the run proves.
    """
    pattern = re.compile(verify["regex"])
    deadline = time.monotonic() + verify["timeout_sec"]
    while True:
        locator = ctx.page.locator(verify["selector"]).first  # type: ignore[attr-defined]
        candidates: list[str] = []
        with suppress(Exception):
            candidates.append(locator.text_content() or "")
        with suppress(Exception):
            candidates.append(locator.get_attribute("data-terminal-text") or "")
        if any(pattern.search(candidate) for candidate in candidates):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.25)


def _typing_args(verb_name: str, args: Any) -> tuple[str | None, str]:
    if isinstance(args, str):
        return None, args
    if (
        isinstance(args, dict)
        and set(args) == {"selector", "text"}
        and isinstance(args["selector"], str)
        and isinstance(args["text"], str)
    ):
        return args["selector"], args["text"]
    raise StepError(f"{verb_name}: expected string or {{selector, text}}")


def _terminal_input_args(args: Any) -> tuple[str, str, bool, dict[str, Any] | None]:
    if not isinstance(args, dict) or set(args) - {"selector", "text", "submit", "verify"}:
        raise StepError("terminal_input: expected {selector, text, submit?, verify?}")
    selector = args.get("selector")
    text = args.get("text")
    submit = args.get("submit", False)
    if not isinstance(selector, str) or not selector:
        raise StepError("terminal_input: selector must be a non-empty string")
    if not isinstance(text, str):
        raise StepError("terminal_input: text must be a string")
    if not isinstance(submit, bool):
        raise StepError("terminal_input: submit must be a boolean")
    verify = args.get("verify")
    parsed_verify = None if verify is None else _terminal_verify_args(verify)
    return selector, text, submit, parsed_verify


def _terminal_verify_args(verify: Any) -> dict[str, Any]:
    if not isinstance(verify, dict) or set(verify) - {"selector", "regex", "timeout_sec", "attempts"}:
        raise StepError("terminal_input: verify expects {selector, regex, timeout_sec?, attempts?}")
    selector = verify.get("selector")
    regex = verify.get("regex")
    timeout = verify.get("timeout_sec", 10)
    attempts = verify.get("attempts", 2)
    if not isinstance(selector, str) or not selector:
        raise StepError("terminal_input: verify selector must be a non-empty string")
    if not isinstance(regex, str) or not regex:
        raise StepError("terminal_input: verify regex must be a non-empty string")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise StepError("terminal_input: verify timeout_sec must be a positive number")
    if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 1:
        raise StepError("terminal_input: verify attempts must be a positive integer")
    return {
        "selector": selector,
        "regex": regex,
        "timeout_sec": float(timeout),
        "attempts": attempts,
    }


@verb("blur")
def step_blur(ctx: StepContext, args: Any) -> None:
    """Remove focus from a control the way leaving the field does.

    The platform drivers disagree about focus-moving keys: a W3C Tab moves
    focus on Windows/Linux, while the macOS in-process bridge cannot perform
    the browser default action for a synthesized Tab, so a blur-committed
    field (clamped number inputs, rename fields) never commits. Calling
    HTMLElement.blur() dispatches the real blur/focusout events on every
    engine and keeps the case about the product behaviour.
    """
    if not isinstance(args, str) or not args:
        raise StepError("blur: expected a non-empty selector string")
    if ctx.dry_run:
        return
    blurred = ctx.page.locator(args).first.evaluate(  # type: ignore[attr-defined]
        "(element) => { element.blur(); return document.activeElement !== element; }"
    )
    if blurred is not True:
        raise StepError(f"blur: element kept focus: {args}")

@verb("compose_text")
def step_compose_text(ctx: StepContext, args: Any) -> None:
    """Drive one browser composition lifecycle through the focused control.

    This is browser interaction evidence only. It deliberately does not claim
    an OS input method or satisfy native IME evidence.
    """
    if not isinstance(args, dict):
        raise StepError("compose_text: expected {selector, text, during_key?}")
    selector = args["selector"]
    text = args["text"]
    during_key = args.get("during_key")
    if not isinstance(text, str) or not text:
        raise StepError("compose_text: text must be a non-empty string")
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.focus()
    session = ctx.page.context.new_cdp_session(ctx.page)  # type: ignore[attr-defined]
    try:
        session.send("Input.imeSetComposition", {
            "text": text,
            "selectionStart": len(text),
            "selectionEnd": len(text),
        })
        if during_key:
            ctx.page.keyboard.press(during_key)  # type: ignore[attr-defined]
        session.send("Input.insertText", {"text": text})
    finally:
        session.detach()


@verb("press")
def step_press(ctx: StepContext, args: Any) -> None:
    if isinstance(args, str):
        key, selector = args, None
    elif isinstance(args, dict):
        key = args["key"]
        if platform.system() == "Darwin" and isinstance(args.get("macos_key"), str):
            key = args["macos_key"]
        selector = args.get("selector")
    else:
        raise StepError("press: expected string or {key, macos_key?, selector?}")
    if ctx.dry_run:
        return
    # Platform Command-Mod: `Mod+X` drives Meta+X on macOS (where CodeMirror
    # maps Mod to Cmd) and Control+X elsewhere, so one testcase covers the
    # platform-native editing primitive on Linux, Windows and macOS.
    key = re.sub(r"(?i)(^|\+)mod(\+|$)", lambda m: f"{m.group(1)}{'Meta' if platform.system() == 'Darwin' else 'Control'}{m.group(2)}", key)
    if selector:
        ctx.page.locator(selector).first.press(key)  # type: ignore[attr-defined]
    else:
        ctx.page.keyboard.press(key)  # type: ignore[attr-defined]


@verb("select_option")
def step_select_option(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("select_option: expected {selector, label?, value?}")
    sel = args["selector"]
    target: dict[str, Any] = {}
    if "label" in args:
        target["label"] = args["label"]
    if "value" in args:
        target["value"] = args["value"]
    if not target:
        raise StepError("select_option: provide label or value")
    if ctx.dry_run:
        return
    ctx.page.locator(sel).first.select_option(**target)  # type: ignore[attr-defined]


@verb("upload_file")
def step_upload_file(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("upload_file: expected {selector, path}")
    selector = args["selector"]
    path = args["path"]
    if ctx.dry_run:
        return
    ctx.page.locator(selector).first.set_input_files(path)  # type: ignore[attr-defined]
