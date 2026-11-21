"""Measure the signed RDP renderer from pointerdown to the decoded Tk color."""

import json
import math
from contextlib import suppress
from pathlib import Path
from typing import Any, Callable

from native_webdriver_transport import WebDriverError

from ..deadline import CaseTimeout, budget_time as time, remaining_timeout
from ..steps import StepError
from .canvas import click_canvas

CASE_ID = "TC-MODULES-056"
REFERENCE_MS = 65
LIMIT_MS = 2 * REFERENCE_MS
SAMPLES = 40
MIN_FRAMES = 36
TARGET_COLORS = {"#000000": "black", "#ffffff": "white"}
OBSERVER = "window.__qaSignedRdpFlip"

INSTALL_OBSERVER = """
const canvas = document.querySelector(CANVAS_SELECTOR);
if (!canvas?.getClientRects().length) return false;
const context = canvas.getContext('2d');
if (!context) return false;
const state = {
  pending: null,
  color() {
    const [r, g, b, a] = context.getImageData(240, 200, 1, 1).data;
    if (a !== 255) return 'unknown';
    if (Math.max(r, g, b) <= 30) return 'black';
    if (Math.min(r, g, b) >= 225) return 'white';
    return 'unknown';
  },
  arm(expected) {
    if (!canvas.isConnected || this.pending) return false;
    this.pending = {expected, started: null, frameMs: null, frameId: null};
    return true;
  },
  reset() {
    if (this.pending?.frameId != null) cancelAnimationFrame(this.pending.frameId);
    this.pending = null;
  },
};
function input(event) {
  const pending = state.pending;
  if (!pending || pending.started !== null || event.button !== 0) return;
  pending.started = performance.now();
  function observe() {
    if (state.pending !== pending || !canvas.isConnected) return;
    if (state.color() === pending.expected) {
      pending.frameMs = performance.now() - pending.started;
      return;
    }
    pending.frameId = requestAnimationFrame(observe);
  }
  pending.frameId = requestAnimationFrame(observe);
}
canvas.addEventListener('pointerdown', input, true);
state.dispose = () => { state.reset(); canvas.removeEventListener('pointerdown', input, true); };
window.__qaSignedRdpFlip?.dispose();
window.__qaSignedRdpFlip = state;
return true;
"""


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def wait_for(read: Callable[[], Any], seconds: float) -> Any:
    deadline = time.monotonic() + remaining_timeout(seconds)
    while True:
        current = read()
        if current is not None:
            return current
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        time.sleep(min(0.025, remaining))


def new_flip(target: Path, previous: int) -> dict[str, Any] | None:
    state = read_json(target)
    return state if state["flips"] > previous else None


def frame_stats(samples: list[dict[str, Any]]) -> dict[str, Any]:
    received = sorted(sample["frameMs"] for sample in samples
                      if sample["targetMatched"] and sample["frameMs"] is not None)
    return {
        "attempted": len(samples),
        "received": len(received),
        "timeouts": sum(sample["targetMatched"] and sample["frameMs"] is None for sample in samples),
        "p95Ms": received[math.ceil(.95 * len(received)) - 1] if received else None,
    }


def run(ctx, args):
    if args is not None or getattr(ctx.fixture_context, "case_id", None) != CASE_ID:
        raise StepError("Signed RDP latency requires the registered native module case")
    report = {
        "caseId": CASE_ID,
        "referenceP95Ms": REFERENCE_MS,
        "limitP95Ms": LIMIT_MS,
        "expectedSamples": SAMPLES,
        "minimumFrames": MIN_FRAMES,
        "samples": [],
        "passed": False,
    }
    target = ctx.case_dir / "target-state.json"
    evaluate = ctx.session.execute
    installed = False
    try:
        receipt = read_json(ctx.case_dir / "signed-rdp/provenance.json")
        frontend = f"/__taomni_plugins__/rdp-client/{receipt['version']}/frontend/index.js"
        canvas = (f'[data-testid="rdp-panel"][data-frontend-source*={json.dumps(frontend)}] '
                  '[data-testid="rdp-canvas"]')
        report.update(sourceSha=receipt["sourceSha"], moduleVersion=receipt["version"],
                      packageSha256=receipt["sha256"], platform=receipt["platform"],
                      frontendSha256=receipt["frontendSha256"])
        installed = evaluate(INSTALL_OBSERVER.replace("CANVAS_SELECTOR", json.dumps(canvas)))
        if not installed:
            raise StepError("The signed RDP framebuffer is not visible")
        for _ in range(SAMPLES):
            baseline = read_json(target)
            initial = TARGET_COLORS[baseline["color"]]
            if wait_for(lambda: evaluate(f"return {OBSERVER}.color() === '{initial}' || null;"), 3) is None:
                raise StepError("The displayed RDP target did not settle to its recorded color")
            expected = "white" if initial == "black" else "black"
            if not evaluate(f"return {OBSERVER}.arm('{expected}');"):
                raise StepError("The signed RDP canvas became unavailable")
            click_canvas(ctx.session, 280, 240, canvas)
            elapsed = wait_for(lambda: evaluate(f"return {OBSERVER}.pending?.frameMs ?? null;"), 2)
            state = wait_for(lambda: new_flip(target, baseline["flips"]), 1)
            sample = state["flip_samples"][-1] if state else None
            matched = (
                sample is not None
                and state["pid"] == baseline["pid"]
                and state["flips"] == sample["flip"] == baseline["flips"] + 1
                and TARGET_COLORS[state["color"]] == expected
                and sample["event_type"] == "ButtonPress"
                and sample["button"] == 1
            )
            report["samples"].append({"frameMs": elapsed, "expectedColor": expected,
                                      "target": sample, "targetMatched": matched})
            if not matched:
                raise StepError("The host target did not record the expected RDP button press and color")
            evaluate(f"{OBSERVER}.reset();")
        stats = frame_stats(report["samples"])
        result = f"Signed RDP viewer p95 {stats['p95Ms']} ms over {stats['received']}/{SAMPLES} frames"
        if stats["received"] < MIN_FRAMES or stats["p95Ms"] > LIMIT_MS:
            raise StepError(result)
        report["passed"] = True
        return result
    except (StepError, CaseTimeout, WebDriverError, OSError, ValueError, KeyError) as error:
        report["error"] = str(error)
        raise
    finally:
        report.update(frame_stats(report["samples"]))
        (ctx.case_dir / "signed-rdp-viewer-latency.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        if installed:
            with suppress(WebDriverError, CaseTimeout):
                evaluate(f"{OBSERVER}?.dispose(); delete {OBSERVER};")
