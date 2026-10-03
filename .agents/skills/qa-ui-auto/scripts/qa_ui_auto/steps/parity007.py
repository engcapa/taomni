"""Controlled browser provider operations for ED-PARITY-007 cases.

These verbs only drive the isolated `/preview/parity007` fixture's controlled
Java provider (timing, failure mode, read-only trace). The Extract transaction,
candidate menu, rename chain, workspace edit and history all remain the
production code paths, and every assertion is made on the real UI.
"""

from __future__ import annotations

import json
from typing import Any

from . import StepContext, StepError, verb

_MODES = {
    "normal", "multi-candidate", "none", "empty-supported", "disabled", "command-only",
    "malformed", "timeout", "changed", "error", "resolve-error", "symbols-error",
    "symbols-ambiguous", "rename-error", "multi-file", "write-failure",
}
_PHASES = {
    "request", "resolve", "symbols-before", "symbols-after", "prepare-rename", "rename",
}


def _observe(ctx: StepContext) -> dict[str, Any]:
    state = ctx.page.evaluate("window.__taomniQaParity007?.observe()")  # type: ignore[attr-defined]
    if not isinstance(state, dict):
        raise StepError("parity007: controlled browser provider is unavailable")
    return state


def _counts(state: dict[str, Any]) -> dict[str, int]:
    events = state.get("events", [])
    return {
        "requests": sum(event.get("phase") == "request" for event in events),
        "resolves": sum(event.get("phase") == "resolve" for event in events),
        "symbols": sum(str(event.get("phase", "")).startswith("symbols-") for event in events),
        "prepares": sum(event.get("phase") == "prepare-rename" for event in events),
        "renames": sum(event.get("phase") == "rename" for event in events),
    }


@verb("parity007_set_mode")
def set_mode(ctx: StepContext, args: Any) -> None:
    mode = str(args)
    if mode not in _MODES:
        raise StepError(f"parity007_set_mode: unsupported mode {mode!r}")
    if ctx.dry_run:
        return
    ctx.page.evaluate("value => window.__taomniQaParity007.setMode(value)", mode)  # type: ignore[attr-defined]


@verb("parity007_hold")
def hold(ctx: StepContext, args: Any) -> None:
    phase = str(args)
    if phase not in _PHASES:
        raise StepError(f"parity007_hold: unsupported phase {phase!r}")
    if ctx.dry_run:
        return
    accepted = ctx.page.evaluate(  # type: ignore[attr-defined]
        "phase => window.__taomniQaParity007?.hold(phase)", phase,
    )
    if accepted is not True:
        raise StepError("parity007_hold: isolated fixture is unavailable")


@verb("parity007_wait_pending")
def wait_pending(ctx: StepContext, args: Any) -> None:
    phase = str(args)
    if phase not in _PHASES:
        raise StepError(f"parity007_wait_pending: unsupported phase {phase!r}")
    if ctx.dry_run:
        return
    ctx.page.wait_for_function(  # type: ignore[attr-defined]
        "phase => window.__taomniQaParity007?.observe().pending.includes(phase)",
        arg=phase,
        timeout=15_000,
    )


@verb("parity007_release")
def release(ctx: StepContext, args: Any) -> None:
    phase = str(args)
    if phase not in _PHASES:
        raise StepError(f"parity007_release: unsupported phase {phase!r}")
    if ctx.dry_run:
        return
    count = ctx.page.evaluate(  # type: ignore[attr-defined]
        "phase => window.__taomniQaParity007?.release(phase)", phase,
    )
    if not isinstance(count, int) or count < 1:
        raise StepError(f"parity007_release: no pending {phase} response")


@verb("parity007_trace")
def trace(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("parity007_trace: expected assertion object")
    if ctx.dry_run:
        return
    for name in ("requests", "resolves", "prepares", "renames"):
        expected = args.get(name)
        if isinstance(expected, int) and expected > 0:
            phase = {"requests": "request", "resolves": "resolve", "prepares": "prepare-rename", "renames": "rename"}[name]
            ctx.page.wait_for_function(  # type: ignore[attr-defined]
                "({phase, expected}) => window.__taomniQaParity007?.observe().events.filter(event => event.phase === phase).length >= expected",
                arg={"phase": phase, "expected": expected},
                timeout=15_000,
            )
    state = _observe(ctx)
    counts = _counts(state)
    pending = state.get("pending", [])
    for name, expected in args.items():
        if name == "range":
            actual_range = state.get("lastRange")
            if actual_range != expected:
                raise StepError(
                    f"parity007_trace: last codeAction range {actual_range!r}, expected {expected!r}"
                )
            continue
        if name == "pending":
            actual = len(pending)
        else:
            actual = counts.get(name)
        if actual != expected:
            raise StepError(f"parity007_trace: {name}={actual}, expected {expected}; state={state}")
    artifact = ctx.case_dir / f"parity007-trace-step{ctx.step_index:02d}.json"
    artifact.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
