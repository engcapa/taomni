"""Passive HTTP and renderer timing for SDK startup failures; no input replay."""
from contextlib import contextmanager
import json
from pathlib import Path
import time
import uuid

SCRIPT = Path(__file__).with_suffix(".js").read_text(encoding="utf-8")
def finish_script(owner: str) -> str:
    return ("const trace=window.__QA_SDK_ACTION_TRACE__; return trace?.owner === "
            + json.dumps(owner) + " ? trace.finish() : null;")


@contextmanager
def capture(session, case_dir: Path):
    original = session.request
    owner = uuid.uuid4().hex
    report = {"requests": [], "renderer": None, "passed": False}

    def request(*args, **kwargs):
        record = {"method": args[0] if args else kwargs.get("method"),
                  "path": args[1] if len(args) > 1 else kwargs.get("path"),
                  "startedEpochMs": time.time() * 1000, "passed": False}
        report["requests"].append(record)
        began = time.monotonic()
        try:
            result = original(*args, **kwargs)
            record["passed"] = True
            return result
        except BaseException as error:
            record["errorType"] = type(error).__name__
            raise
        finally:
            record["durationMs"] = (time.monotonic() - began) * 1000

    session.request = request
    failed = False
    try:
        if session.execute("return (" + SCRIPT + ")(" + json.dumps(owner) + ");") is not True:
            raise RuntimeError("SDK action trace failed to install")
        yield
        report["passed"] = True
    except BaseException:
        failed = True
        raise
    finally:
        try:
            try:
                report["renderer"] = session.execute(finish_script(owner))
                if not isinstance(report["renderer"], dict):
                    raise RuntimeError("SDK action trace renderer is unavailable")
            except Exception as error:
                report["captureError"] = str(error)
                report["passed"] = False
                if not failed:
                    failed = True
                    raise
        finally:
            if session.request is request:
                session.request = original
            else:
                report["captureError"] = "SDK request trace owner changed"
                report["passed"] = False
            try:
                (case_dir / "sdk-action-trace.json").write_text(
                    json.dumps(report, indent=2) + "\n", encoding="utf-8")
            except Exception:
                if not failed:
                    raise
            if report.get("captureError") and not failed:
                raise RuntimeError(report["captureError"])
