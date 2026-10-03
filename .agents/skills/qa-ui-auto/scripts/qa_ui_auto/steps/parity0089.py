"""Controlled browser fixtures for ED-PARITY-008 (Git) and ED-PARITY-009 (SSR).

They only change response timing/mode at the Tauri browser bridge and read an
in-page trace; every user action still goes through the production UI. They
cannot prove real Git bytes, Tauri IPC or the native tree-sitter parser.
"""

from __future__ import annotations

import json
from typing import Any

from . import StepContext, StepError, verb


def _observe(ctx: StepContext, name: str) -> dict[str, Any]:
    state = ctx.page.evaluate(f"window.__taomniQa{name}?.observe()")  # type: ignore[attr-defined]
    if not isinstance(state, dict):
        raise StepError(f"{name.lower()}: controlled browser fixture is unavailable")
    return state


def _save(ctx: StepContext, prefix: str, state: dict[str, Any]) -> None:
    artifact = ctx.case_dir / f"{prefix}-trace-step{ctx.step_index:02d}.json"
    artifact.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


@verb("parity008_hold")
def parity008_hold(ctx: StepContext, args: Any) -> None:
    if args is not None and not isinstance(args, str):
        raise StepError("parity008_hold: expected a repo root string or null")
    if ctx.dry_run:
        return
    ctx.page.evaluate("value => window.__taomniQaParity008.hold(value)", args)  # type: ignore[attr-defined]


@verb("parity008_release")
def parity008_release(ctx: StepContext, _args: Any) -> None:
    if ctx.dry_run:
        return
    count = ctx.page.evaluate("window.__taomniQaParity008?.release()")  # type: ignore[attr-defined]
    if not isinstance(count, int) or count < 1:
        raise StepError("parity008_release: no held diff read to release")


@verb("parity008_trace")
def parity008_trace(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict) or not args:
        raise StepError("parity008_trace: expected assertion object")
    if ctx.dry_run:
        return
    wait_min = args.get("pending_min") or (args["pending"] if isinstance(args.get("pending"), int) else 0)
    if wait_min > 0:
        ctx.page.wait_for_function(  # type: ignore[attr-defined]
            "n => (window.__taomniQaParity008?.observe().pending.length ?? 0) >= n",
            arg=wait_min,
            timeout=10_000,
        )
    state = _observe(ctx, "Parity008")
    if "writes" in args and len(state.get("writes", [])) != args["writes"]:
        raise StepError(f"parity008_trace: writes={state.get('writes')}, expected {args['writes']}")
    if "pending" in args and len(state.get("pending", [])) != args["pending"]:
        raise StepError(f"parity008_trace: pending={state.get('pending')}, expected {args['pending']}")
    if "pending_min" in args and len(state.get("pending", [])) < args["pending_min"]:
        raise StepError(f"parity008_trace: pending={state.get('pending')}, expected at least {args['pending_min']}")
    if "last_pair_repo" in args:
        reads = state.get("pairReads", [])
        last = reads[-1]["repoRoot"] if reads else None
        if last != args["last_pair_repo"]:
            raise StepError(f"parity008_trace: last diff read for {last!r}, expected {args['last_pair_repo']!r}")
    _save(ctx, "parity008", state)


@verb("parity009_set_mode")
def parity009_set_mode(ctx: StepContext, args: Any) -> None:
    mode = str(args)
    if mode not in {"normal", "hold", "unavailable", "error"}:
        raise StepError(f"parity009_set_mode: unsupported mode {mode!r}")
    if ctx.dry_run:
        return
    ctx.page.evaluate("value => window.__taomniQaParity009.setMode(value)", mode)  # type: ignore[attr-defined]


@verb("parity009_release")
def parity009_release(ctx: StepContext, _args: Any) -> None:
    if ctx.dry_run:
        return
    count = ctx.page.evaluate("window.__taomniQaParity009?.release()")  # type: ignore[attr-defined]
    if not isinstance(count, int) or count < 1:
        raise StepError("parity009_release: no held structural search to release")


@verb("parity009_trace")
def parity009_trace(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict) or not args:
        raise StepError("parity009_trace: expected assertion object")
    if ctx.dry_run:
        return
    if isinstance(args.get("active"), int) and args["active"] > 0:
        ctx.page.wait_for_function(  # type: ignore[attr-defined]
            "n => (window.__taomniQaParity009?.observe().active.length ?? 0) >= n",
            arg=args["active"],
            timeout=10_000,
        )
    if isinstance(args.get("runs"), int):
        ctx.page.wait_for_function(  # type: ignore[attr-defined]
            "n => (window.__taomniQaParity009?.observe().runs.length ?? 0) >= n",
            arg=args["runs"],
            timeout=10_000,
        )
    state = _observe(ctx, "Parity009")
    runs = state.get("runs", [])
    last = runs[-1] if runs else {}
    checks = {
        "active": len(state.get("active", [])),
        "runs": len(runs),
        "last_status": last.get("status"),
        "last_count": last.get("count"),
    }
    for key, expected in args.items():
        if checks[key] != expected:
            raise StepError(f"parity009_trace: {key}={checks[key]!r}, expected {expected!r}; state={state}")
    _save(ctx, "parity009", state)
