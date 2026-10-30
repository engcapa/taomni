"""Opt-in forwarding diagnostics, separate from workspace performance verdicts."""
from contextlib import contextmanager
import json
from pathlib import Path
import platform
import subprocess
from .steps import StepError

SCRIPT = Path(__file__).with_suffix(".js").read_text(encoding="utf-8")


@contextmanager
def native_host_sample(ctx, label, report):
    pid = getattr(ctx.session, "owned_app_pid", None)
    if platform.system() != "Darwin" or type(pid) is not int or pid <= 0:
        yield
        return
    # This is the exact app child owned by this session. Sample its Cocoa /
    # runtime stacks as well as renderer calls to distinguish queueing from JS.
    path = ctx.case_dir / ("workspace-host-" + label + ".sample.log")
    error_path = ctx.case_dir / ("workspace-host-" + label + ".sample-error.log")
    report["nativeHostSample"] = {"pid": pid, "path": path.name}
    with error_path.open("w", encoding="utf-8") as errors:
        process = subprocess.Popen(["sample", str(pid), "8" if label == "sdk" else "3", "10",
                                    "-file", str(path)], stdout=subprocess.DEVNULL, stderr=errors)
        try:
            yield
        finally:
            try:
                report["nativeHostSample"]["exitCode"] = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
                report["nativeHostSample"]["error"] = "sample exceeded its bounded diagnostic window"


@contextmanager
def capture(ctx, label):
    if getattr(ctx, "cfg", {}).get("diagnostics", {}).get("workspace_stage_trace") is not True:
        yield
        return
    report = {"diagnosticOnly": True, "label": label, "events": None}
    if ctx.session.execute("return (" + SCRIPT + ")();") is not True:
        raise RuntimeError("Workspace stage diagnostics failed to install")
    failed = False
    try:
        with native_host_sample(ctx, label, report):
            yield
    except BaseException:
        failed = True
        raise
    finally:
        try:
            report["events"] = ctx.session.execute(
                "return window.__QA_WORKSPACE_STAGE_TRACE__?.finish() ?? null;")
            if report["events"] is None:
                raise RuntimeError("Workspace stage diagnostics disappeared")
        except Exception as error:
            report["captureError"] = str(error)
            if not failed:
                raise
        finally:
            (ctx.case_dir / ("workspace-stages-" + label + ".json")).write_text(
                json.dumps(report, indent=2) + "\n", encoding="utf-8")
    raise StepError("Diagnostic-only workspace stage trace; rerun without tracing for acceptance")
