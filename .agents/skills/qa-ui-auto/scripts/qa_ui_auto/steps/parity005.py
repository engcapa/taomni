"""Controlled browser provider operations for ED-PARITY-005 cases."""

from __future__ import annotations

import json
from typing import Any

from . import StepContext, StepError, verb


_MODES = {
    "normal", "empty", "empty-placeholder", "fetch-hold", "resolve-hold", "resolve-null",
    "resolve-error", "resolve-timeout", "resolve-overlap", "resolve-invalid",
}
_PHASES = {"fetch", "resolve"}


def _observe(ctx: StepContext) -> dict[str, Any]:
    state = ctx.page.evaluate("window.__taomniQaParity005?.observe()")  # type: ignore[attr-defined]
    if not isinstance(state, dict):
        raise StepError("parity005: controlled browser provider is unavailable")
    return state


@verb("parity005_set_mode")
def set_mode(ctx: StepContext, args: Any) -> None:
    mode = str(args)
    if mode not in _MODES:
        raise StepError(f"parity005_set_mode: unsupported mode {mode!r}")
    if ctx.dry_run:
        return
    ctx.page.evaluate("value => window.__taomniQaParity005.setMode(value)", mode)  # type: ignore[attr-defined]


@verb("parity005_set_facts")
def set_facts(ctx: StepContext, args: Any) -> None:
    status = str(args)
    if status not in {"ready", "loading", "degraded", "failed", "stale"}:
        raise StepError(f"parity005_set_facts: unsupported status {status!r}")
    if ctx.dry_run:
        return
    generation = ctx.page.evaluate(  # type: ignore[attr-defined]
        "status => window.__taomniQaParity005?.setFactsStatus(status)", status,
    )
    if not isinstance(generation, int) or generation < 1:
        raise StepError("parity005_set_facts: isolated fixture is unavailable")


@verb("parity005_wait_pending")
def wait_pending(ctx: StepContext, args: Any) -> None:
    phase = str(args)
    if phase not in _PHASES:
        raise StepError(f"parity005_wait_pending: unsupported phase {phase!r}")
    if ctx.dry_run:
        return
    ctx.page.wait_for_function(  # type: ignore[attr-defined]
        "phase => window.__taomniQaParity005?.observe().pending.includes(phase)",
        arg=phase,
        timeout=10_000,
    )


@verb("parity005_release")
def release(ctx: StepContext, args: Any) -> None:
    phase = str(args)
    if phase not in _PHASES:
        raise StepError(f"parity005_release: unsupported phase {phase!r}")
    if ctx.dry_run:
        return
    count = ctx.page.evaluate(  # type: ignore[attr-defined]
        "phase => window.__taomniQaParity005?.release(phase)", phase,
    )
    if not isinstance(count, int) or count < 1:
        raise StepError(f"parity005_release: no pending {phase} response")


@verb("parity005_trace")
def trace(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("parity005_trace: expected assertion object")
    if ctx.dry_run:
        return
    for phase in _PHASES:
        expected = args.get(phase)
        if isinstance(expected, int) and expected > 0:
            ctx.page.wait_for_function(  # type: ignore[attr-defined]
                "({phase, expected}) => window.__taomniQaParity005?.observe().events.filter(event => event.phase === phase).length >= expected",
                arg={"phase": phase, "expected": expected},
                timeout=10_000,
            )
    state = _observe(ctx)
    events = state.get("events", [])
    pending = state.get("pending", [])
    counts = {
        "fetch": sum(event.get("phase") == "fetch" for event in events),
        "resolve": sum(event.get("phase") == "resolve" for event in events),
    }
    for name, expected in args.items():
        actual = len(pending) if name == "pending" else counts[name]
        if actual != expected:
            raise StepError(f"parity005_trace: {name}={actual}, expected {expected}; state={state}")
    artifact = ctx.case_dir / f"parity005-trace-step{ctx.step_index:02d}.json"
    artifact.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
