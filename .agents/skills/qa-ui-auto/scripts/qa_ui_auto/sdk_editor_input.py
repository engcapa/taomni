"""Measure real paced keys separately from the time spent typing a whole file.

Every input batch retains the 1.5s action budget; each key has a 150ms frame
baseline with the approved 10% tolerance.
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
from .workspace_frame_budget import FRAME_BUDGET_MS, FRAME_LIMIT_MS, FRAME_TOLERANCE_PERCENT

KEY_FRAME_BUDGET_MS = FRAME_BUDGET_MS
KEY_ACTION_BUDGET_MS = 1500
INPUT_BATCH_SIZE = 8


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
      caret:view.state.selection.main.head,keyCount:state.keys.length});
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
    previous_count = 0
    for index, frame in enumerate(frames):
        latency = frame.get("frameMs")
        if type(latency) not in {int, float} or not math.isfinite(latency) or not 0 <= latency <= FRAME_LIMIT_MS:
            raise StepError(f"SDK typing key {index + 1} exceeded the {FRAME_LIMIT_MS:g}ms frame limit "
                            f"({KEY_FRAME_BUDGET_MS}ms + {FRAME_TOLERANCE_PERCENT}% tolerance): {latency}")
        # More than one real key may be delivered before the next frame. Check
        # that frame against every key observed by then, not just its first key.
        count = frame.get("keyCount")
        if (type(count) is not int or not max(index + 1, previous_count) <= count <= len(text)
                or not frame.get("document", "").startswith(text[:count])
                or frame.get("caret") != count):
            raise StepError(f"SDK typing key {index + 1} did not reach the canonical editor document/caret")
        previous_count = count
    # Automatic closing brackets are valid intermediate suffixes. The final
    # review requires exact text, with no normalization or bracket repair.
    if exact and (not frames or frames[-1].get("document") != text or frames[-1].get("dom") != text):
        raise StepError("SDK typing did not retain the complete exact source in the editor and DOM")


def measure(session: Any, selector: str, text: str, case_dir: Path,
            require_pending: Callable[[], Any]) -> dict:
    report = {"passed": False, "text": text, "keyActionBudgetMs": KEY_ACTION_BUDGET_MS,
              "keyFrameBudgetMs": KEY_FRAME_BUDGET_MS, "batchSize": INPUT_BATCH_SIZE,
              "keyFrameTolerancePercent": FRAME_TOLERANCE_PERCENT, "keyFrameLimitMs": FRAME_LIMIT_MS,
              "requests": []}
    started = time.monotonic()
    installed = False
    try:
        if session.execute(install_script(selector)) is not True:
            raise StepError("SDK typing observer could not bind the focused real editor")
        installed = True
        for offset in range(0, len(text), INPUT_BATCH_SIZE):
            batch = text[offset:offset + INPUT_BATCH_SIZE]
            end = offset + len(batch)
            began = time.monotonic()
            request = {"text": batch, "firstKey": offset + 1, "lastKey": end, "passed": False}
            report["requests"].append(request)
            try:
                # Preserve the driver's real keyboard events and its original
                # 20ms per-key pacing. Reading IPC/heartbeats after every key
                # otherwise adds ~100 WebDriver round trips to this short text,
                # consuming the real SDK's unchanged five-second lifetime.
                session.type_text(batch)
                deadline = began + KEY_ACTION_BUDGET_MS / 1000
                while True:
                    state = session.execute(READ_SCRIPT)
                    if isinstance(state, dict) and len(state.get("frames", [])) >= end:
                        break
                    if time.monotonic() >= deadline:
                        raise StepError("SDK typing frame did not appear within 1500ms")
                    time.sleep(.01)
                review(state, text[:end], exact=end == len(text))
                request["sdkPending"] = require_pending()
                if (time.monotonic() - began) * 1000 > KEY_ACTION_BUDGET_MS:
                    raise StepError("SDK typing batch request exceeded the unchanged 1500ms action budget")
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


