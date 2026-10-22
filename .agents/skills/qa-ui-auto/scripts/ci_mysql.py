"""Retain native MySQL bootstrap evidence before its private data is removed."""
from pathlib import Path
import json
import subprocess
import time


def initialize_mysql(common, data: Path, report: Path, *, timeout=180):
    report.mkdir(parents=True, exist_ok=True)
    log = report / "mysql-initialize.log"
    outcome = {"stage": "initialize", "timeout_seconds": timeout}
    started = time.monotonic()
    try:
        # Windows otherwise writes its only error log inside the temporary
        # datadir. File-backed console output survives both timeout and cleanup.
        with log.open("wb") as stream:
            result = subprocess.run([str(arg) for arg in [*common, "--initialize-insecure", "--console"]],
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
        outcome["exit_code"] = result.returncode
        if result.returncode:
            raise RuntimeError(f"MySQL initialization failed ({result.returncode}); see {log}")
        outcome["status"] = "passed"
    except subprocess.TimeoutExpired as exc:
        outcome["status"] = "timeout"
        raise RuntimeError(f"MySQL initialization exceeded {timeout}s; see {log}") from exc
    except BaseException as exc:
        outcome["status"] = "failed"
        outcome["error"] = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        outcome["elapsed_seconds"] = round(time.monotonic() - started, 3)
        for source in data.glob("*.err"):
            (report / f"mysql-initialize-{source.name}").write_bytes(source.read_bytes()[-1024 * 1024:])
        (report / "mysql-initialize.json").write_text(json.dumps(outcome, indent=2), encoding="utf-8")
