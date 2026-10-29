"""Own browser trace recording without adding DOM snapshots to frame probes."""
from pathlib import Path
from typing import Any


def start(context: Any, case: dict) -> dict:
    # Playwright captures the entire DOM around each locator action. The CPU
    # profiles show captureSnapshot/visitNode inside measured frame gaps. Keep
    # action/network/console tracing, but exclude this observer work from file
    # responsiveness cases. Failure screenshots/HTML are captured separately.
    measures_frames = any(
        isinstance(step, dict) and "measure_workspace_file_open" in step
        for step in case.get("steps", [])
    )
    options = {"screenshots": not measures_frames, "snapshots": not measures_frames, "sources": False}
    try:
        context.tracing.start(**options)
        return {**options, "started": True}
    except Exception as error:
        return {**options, "started": False, "error": str(error)}


def stop(context: Any, case_dir: Path, report_root: Path, failure: dict | None) -> None:
    try:
        trace_path = case_dir / "trace.zip"
        context.tracing.stop(**({"path": str(trace_path)} if failure is not None else {}))
        if failure is not None:
            failure.setdefault("artifacts", {})["trace"] = str(trace_path.relative_to(report_root))
    except Exception:
        # Diagnostic cleanup cannot replace the original product failure.
        pass
