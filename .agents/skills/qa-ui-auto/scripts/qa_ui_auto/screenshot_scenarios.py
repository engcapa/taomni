"""Isolated native screenshot scenarios; never a raw-JS testcase escape hatch.

Promises are settled in a slot then observed synchronously. WKWebView's QA
bridge does not serialize pending Promises returned by execute/sync.
"""
from __future__ import annotations

import json
import uuid
from .deadline import CaseTimeout, budget_time as time
from .steps import StepError

SCENARIOS = {
    "displays": "screenshot_qa_displays",
    "capture": "screenshot_qa_capture",
    "capture-fidelity": "screenshot_qa_capture_fidelity",
    "ocr-redact": "screenshot_qa_ocr_redact",
    "scroll": "screenshot_qa_scroll",
    "overlay-copy": "screenshot_qa_overlay_copy",
    "record": "screenshot_qa_record",
    "recorder": "screenshot_qa_recorder",
    "pin": "screenshot_qa_pin",
    "pin-tools": "screenshot_qa_pin_tools",
    "pin-arrangement": "screenshot_qa_pin_arrangement",
    "scroll-manual": "screenshot_qa_scroll_manual",
    "scroll-exit": "screenshot_qa_scroll_exit",
    "colors": "screenshot_qa_colors",
    "annotation-tools": "screenshot_qa_annotation_tools",
    "freehand": "screenshot_qa_freehand",
    "hotkey": "screenshot_qa_hotkey",
    "controls": "screenshot_qa_controls",
    "full-recorder": "screenshot_qa_full_recorder",
    "macos-capture-source": "screenshot_qa_macos_capture_source",
    "scroll-permission-error": "screenshot_qa_scroll_permission_error",
    "capture-permission-error": "screenshot_qa_capture_permission_error",
}


def run_scenario(ctx, args):
    if not isinstance(args, dict) or set(args) - {"scenario", "format", "secs"}:
        raise StepError("native_screenshot_scenario: expected scenario, optional format/secs")
    scenario = args.get("scenario")
    if scenario not in SCENARIOS:
        raise StepError(f"native_screenshot_scenario: unknown scenario {scenario!r}")
    params = {}
    if scenario in {"record", "recorder", "macos-capture-source"}:
        if args.get("format") not in {"gif", "mp4"}:
            raise StepError("native_screenshot_scenario: record/recorder/macos-capture-source requires gif or mp4")
        params["format"] = args["format"]
    elif "format" in args:
        raise StepError("native_screenshot_scenario: format only applies to record/recorder/macos-capture-source")
    if scenario == "record":
        secs = args.get("secs", 3)
        if isinstance(secs, bool) or not isinstance(secs, int) or not 1 <= secs <= 8:
            raise StepError("native_screenshot_scenario: secs must be an integer in 1..8")
        params["secs"] = secs
    elif "secs" in args:
        raise StepError("native_screenshot_scenario: secs only applies to record")

    slot = "__qaScreenshot_" + uuid.uuid4().hex
    key = json.dumps(slot)
    command = json.dumps(SCENARIOS[scenario])
    result = None
    transport_error = None
    path = ctx.case_dir / f"screenshot-{scenario}-{params.get('format', 'png')}-{slot[-8:]}.json"
    try:
        started = ctx.session.execute(
            f"window[{key}] = {{done:false}}; "
            f"window.__TAURI_INTERNALS__.invoke({command}, {json.dumps(params)}).then("
            f"value => window[{key}] = {{done:true,value}}, "
            f"error => window[{key}] = {{done:true,error:String(error)}}); return true;"
        )
        if started is not True:
            raise StepError("native_screenshot_scenario: could not start isolated QA command")
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            state = ctx.session.execute(f"return window[{key}] || null;")
            if isinstance(state, dict) and state.get("done"):
                result = state
                break
            time.sleep(0.2)
    except CaseTimeout as error:
        transport_error = str(error)
        raise
    except Exception as error:
        transport_error = str(error)
        raise StepError(f"native_screenshot_scenario: {error}; see {path.name}") from error
    finally:
        try:
            ctx.session.execute(f"delete window[{key}]; return true;")
        except Exception:
            pass
        path.write_text(json.dumps({"scenario": scenario, "params": params, "result": result,
                                    "transportError": transport_error},
                                   indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if result is None:
        raise StepError(f"native_screenshot_scenario: {scenario} timed out; see {path.name}")
    if "error" in result:
        raise StepError(f"native_screenshot_scenario: {result['error']}")
    value = result.get("value")
    if not isinstance(value, str) or not value.startswith("OK "):
        raise StepError(f"native_screenshot_scenario: {value!r}; see {path.name}")
    try:
        details = json.loads(value[3:])
    except (TypeError, ValueError) as e:
        raise StepError(f"native_screenshot_scenario: invalid evidence: {e}") from e
    if not isinstance(details, dict) or not details:
        raise StepError("native_screenshot_scenario: missing evidence details")
    return f"native {scenario} verified: {path.name}; {value}"
