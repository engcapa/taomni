"""Observe a real file activation and its first content/highlight frames."""
from __future__ import annotations

import json
import math
from contextlib import nullcontext
from pathlib import Path
import re
from typing import Any

from .deadline import budget_time as time
from .steps import StepError
from .file_open_profile import capture as capture_profile

SCRIPT = Path(__file__).with_suffix(".js").read_text(encoding="utf-8")
OPEN_BUDGET_MS = 1500
FRAME_BUDGET_MS = 150


def validate(args: Any) -> dict:
    if (not isinstance(args, dict) or set(args) != {"selector", "expected", "event", "label"}
            or not all(isinstance(value, str) and value for value in args.values())
            or args["event"] not in {"click", "dblclick"}
            or not re.fullmatch(r"[a-z0-9-]+", args["label"])):
        raise StepError("measure_workspace_file_open expects {selector, expected, event: click|dblclick, label}")
    return args


def review(state: Any) -> None:
    if not isinstance(state, dict) or state.get("started") is None or not state.get("finished"):
        raise StepError("File activation did not produce the exact visible document and syntax-highlighted frame")
    for key in ["firstContentMs", "firstHighlightMs"]:
        value = state.get(key)
        if type(value) not in {int, float} or not math.isfinite(value) or not 0 <= value <= OPEN_BUDGET_MS:
            raise StepError(f"File {key} exceeded {OPEN_BUDGET_MS}ms: {value}")
    frames = state.get("frames")
    if not isinstance(frames, list) or not frames:
        raise StepError("File activation has no real frame observations")
    for index, frame in enumerate(frames):
        value = frame.get("gapMs")
        if type(value) not in {int, float} or not math.isfinite(value) or not 0 <= value <= FRAME_BUDGET_MS:
            raise StepError(f"File activation frame {index + 1} blocked beyond {FRAME_BUDGET_MS}ms: {value}")
    if not frames[-1].get("matches") or not frames[-1].get("highlighted"):
        raise StepError("File activation lost its document or highlighting after the first frame")


def run(ctx: Any, args: Any) -> str:
    config = validate(args)
    profile = (nullcontext() if hasattr(ctx, "session") else capture_profile(
        ctx.page, ctx.case_dir / ("file-open-" + config["label"] + "-cpu-profile.json")))
    with profile:
        return measure(ctx, config)


def measure(ctx: Any, args: Any) -> str:
    config = validate(args)
    native = hasattr(ctx, "session")
    execute = ctx.session.execute if native else lambda source: ctx.page.evaluate("() => {" + source + "}")
    report = {"passed": False, "label": config["label"], "mode": "native" if native else "browser",
              "openBudgetMs": OPEN_BUDGET_MS, "frameBudgetMs": FRAME_BUDGET_MS}
    installed = False
    state = None
    failed = False
    started = time.monotonic()
    try:
        if execute("return (" + SCRIPT + ")(" + json.dumps(config) + ");") is not True:
            raise StepError("File-open frame observer failed to install")
        installed = True
        action_started = time.monotonic()
        if native:
            getattr(ctx.session, config["event"])(config["selector"])
        else:
            getattr(ctx.page.locator(config["selector"]), config["event"])()
        report["driverActionMs"] = (time.monotonic() - action_started) * 1000
        deadline = time.monotonic() + 10
        while True:
            state = execute("return window.__QA_FILE_OPEN_PROBE__?.state ?? null;")
            if isinstance(state, dict) and state.get("finished"):
                break
            if time.monotonic() >= deadline:
                raise StepError("File-open frame observer did not finish")
            time.sleep(.025)
        review(state)
        report["passed"] = True
        return "Exact JSON document, syntax highlighting and continuous responsive frames observed after real activation"
    except BaseException:
        failed = True
        raise
    finally:
        try:
            if installed:
                state = execute("return window.__QA_FILE_OPEN_PROBE__?.finish() ?? null;")
        except Exception as error:
            report["captureError"] = str(error)
            report["passed"] = False
            if not failed:
                raise
        finally:
            report["observation"] = state
            report["durationMs"] = (time.monotonic() - started) * 1000
            try:
                (ctx.case_dir / ("file-open-" + config["label"] + ".json")).write_text(
                    json.dumps(report, indent=2) + "\n", encoding="utf-8")
            except Exception:
                if not failed:
                    raise
