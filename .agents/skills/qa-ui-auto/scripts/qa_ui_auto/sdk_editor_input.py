"""Measure real paced keys separately from the time spent typing a whole file.

Every key retains the 1.5s action budget and has a stricter 150ms frame budget.
The full wall time, all characters and native event/frame observations remain in
the report. No JS document writes, input dispatch or faster driver pacing.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Callable

from .deadline import budget_time as time
from .steps import StepError

KEY_FRAME_BUDGET_MS = 150
KEY_ACTION_BUDGET_MS = 1500


def install_script(selector: str) -> str:
    return """
const el=document.querySelector(SELECTOR);
const view=el?.cmTile?.root?.view;
if(!el || !view || document.activeElement!==el) return false;
const state={keys:[],frames:[],inputs:[]};
const keydown=event=>{
  if(event.key.length!==1 || event.ctrlKey || event.metaKey || event.altKey) return;
  const sample={key:event.key,started:performance.now(),trusted:event.isTrusted,frameMs:null};
  state.keys.push(sample);
  requestAnimationFrame(()=>{
    sample.frameMs=performance.now()-sample.started;
    state.frames.push({key:sample.key,frameMs:sample.frameMs,
      document:view.state.doc.toString(),dom:el.textContent,
      caret:view.state.selection.main.head});
  });
};
const input=event=>state.inputs.push({type:event.type,data:event.data,
  inputType:event.inputType,time:performance.now(),trusted:event.isTrusted});
el.addEventListener('keydown',keydown,true);
el.addEventListener('beforeinput',input,true);
el.addEventListener('input',input,true);
window.__QA_SDK_TYPING__={state,cleanup:()=>{
  el.removeEventListener('keydown',keydown,true);
  el.removeEventListener('beforeinput',input,true);
  el.removeEventListener('input',input,true);
}};
return true;
""".replace("SELECTOR", json.dumps(selector))


READ_SCRIPT = "return window.__QA_SDK_TYPING__?.state ?? null;"
CLEANUP_SCRIPT = "const observer=window.__QA_SDK_TYPING__; observer?.cleanup(); return observer?.state ?? null;"


def review(state: Any, text: str, *, exact: bool = True) -> None:
    if not isinstance(state, dict):
        raise StepError("SDK typing observer is unavailable")
    keys, frames = state.get("keys", []), state.get("frames", [])
    if [item.get("key") for item in keys] != list(text) or [item.get("key") for item in frames] != list(text):
        raise StepError("SDK typing keys/frames were lost, duplicated or reordered")
    for index, frame in enumerate(frames):
        latency = frame.get("frameMs")
        if type(latency) not in {int, float} or not math.isfinite(latency) or not 0 <= latency <= KEY_FRAME_BUDGET_MS:
            raise StepError(f"SDK typing key {index + 1} exceeded the {KEY_FRAME_BUDGET_MS}ms frame budget: {latency}")
        if not frame.get("document", "").startswith(text[:index + 1]) or frame.get("caret") != index + 1:
            raise StepError(f"SDK typing key {index + 1} did not reach the canonical editor document/caret")
    # Automatic closing brackets are valid intermediate suffixes. The final
    # review requires exact text, with no normalization or bracket repair.
    if exact and (not frames or frames[-1].get("document") != text or frames[-1].get("dom") != text):
        raise StepError("SDK typing did not retain the complete exact source in the editor and DOM")


def measure(session: Any, selector: str, text: str, case_dir: Path,
            require_pending: Callable[[], Any]) -> dict:
    report = {"passed": False, "text": text, "keyActionBudgetMs": KEY_ACTION_BUDGET_MS,
              "keyFrameBudgetMs": KEY_FRAME_BUDGET_MS, "requests": []}
    started = time.monotonic()
    installed = False
    try:
        if session.execute(install_script(selector)) is not True:
            raise StepError("SDK typing observer could not bind the focused real editor")
        installed = True
        for index, character in enumerate(text):
            began = time.monotonic()
            request = {"key": character, "passed": False}
            report["requests"].append(request)
            try:
                session.type_text(character)
                deadline = began + KEY_ACTION_BUDGET_MS / 1000
                while True:
                    state = session.execute(READ_SCRIPT)
                    if isinstance(state, dict) and len(state.get("frames", [])) >= index + 1:
                        break
                    if time.monotonic() >= deadline:
                        raise StepError("SDK typing frame did not appear within 1500ms")
                    time.sleep(.01)
                review(state, text[:index + 1], exact=index == len(text) - 1)
                request["sdkPending"] = require_pending()
                if (time.monotonic() - began) * 1000 > KEY_ACTION_BUDGET_MS:
                    raise StepError("SDK typing key request exceeded the unchanged 1500ms action budget")
                request["passed"] = True
            finally:
                request["durationMs"] = (time.monotonic() - began) * 1000
        report["passed"] = True
        return report
    finally:
        report["durationMs"] = (time.monotonic() - started) * 1000
        try:
            if installed:
                try:
                    report["observation"] = session.execute(CLEANUP_SCRIPT)
                except Exception as error:
                    report["captureError"] = str(error)
                    if report["passed"]:
                        report["passed"] = False
                        raise
        finally:
            (case_dir / "sdk-typing-responsiveness.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


