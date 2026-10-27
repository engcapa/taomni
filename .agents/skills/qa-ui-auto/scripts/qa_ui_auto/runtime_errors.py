"""Explicit crash assertions for renderer workflows, without treating warnings as crashes."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CRASH_SNAPSHOT = """({
  crash: document.querySelector('[data-testid="app-crash"]')?.textContent ?? null
})"""
NATIVE_SNAPSHOT = """({
  installed: Array.isArray(window.__QA_UI_AUTO_CONSOLE__),
  entries: window.__QA_UI_AUTO_CONSOLE__ ?? [],
  resizeObservers: window.__QA_UI_AUTO_RESIZE_TRACE__ ? {
    created: window.__QA_UI_AUTO_RESIZE_TRACE__.created,
    samples: window.__QA_UI_AUTO_RESIZE_TRACE__.samples.slice()
  } : null,
  crash: document.querySelector('[data-testid="app-crash"]')?.textContent ?? null
})"""


def assert_snapshot(snapshot: Any, case_dir: Path, mode: str) -> str:
    """Keep raw observations before failing; earlier errors never become a pass."""
    from .steps import StepError

    artifact = case_dir / "runtime-errors.jsonl"
    with artifact.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"mode": mode, "snapshot": snapshot}, ensure_ascii=False) + "\n")
    if not isinstance(snapshot, dict) or snapshot.get("installed") is not True:
        raise StepError("assert_no_runtime_errors: runtime monitor unavailable")
    entries = snapshot.get("entries")
    if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
        raise StepError("assert_no_runtime_errors: invalid runtime observations")
    errors = []
    for entry in entries:
        text = str(entry.get("text", ""))
        args = entry.get("args")
        if isinstance(args, list):
            text = " ".join(str(value) for value in args)
        uncaught = entry.get("kind") in {"uncaught-error", "unhandled-rejection"}
        browser_error = mode == "browser" and text.startswith("pageerror: ")
        react_boundary = entry.get("level") == "error" and "[ui] React render failed" in text
        if uncaught or browser_error or react_boundary:
            errors.append(text)
    if snapshot.get("crash"):
        errors.append(str(snapshot["crash"]))
    if errors:
        raise StepError("assert_no_runtime_errors: " + "\n".join(errors))
    return "no uncaught errors, unhandled rejections or app crash UI"


def browser_assert(ctx: Any, args: Any) -> None:
    from .steps import StepError

    if args is not None:
        raise StepError("assert_no_runtime_errors: expected null")
    if ctx.dry_run:
        return
    console = ctx.case_state.get("runtime_console")
    observation = ctx.page.evaluate(CRASH_SNAPSHOT)
    snapshot = {**observation, "installed": isinstance(console, list), "entries": console}
    assert_snapshot(snapshot, ctx.case_dir, "browser")


def native_assert(ctx: Any, args: Any) -> str:
    from .steps import StepError

    if args is not None:
        raise StepError("assert_no_runtime_errors: expected null")
    snapshot = ctx.session.execute("return " + NATIVE_SNAPSHOT + ";")
    return assert_snapshot(snapshot, ctx.case_dir, "native")
