"""Retry transient Maven repository transfers within the original warmup budget."""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import time
from typing import Sequence


_TRANSFER = re.compile(r"could not transfer (?:artifact|metadata)", re.IGNORECASE)
_TRANSIENT = re.compile(
    r"(?:status code:|HTTP Status:)\s*(?:408|429|5\d\d)\b|(?:read|connect(?:ion)?) timed out|"
    r"connection reset|temporary failure in name resolution",
    re.IGNORECASE,
)


def _text(value: str | bytes | None) -> str:
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value or ""


def warm_maven(command: Sequence[str], cwd: Path, report_root: Path) -> str:
    """Keep permanent/build errors fatal; retry only failed repository transfers."""
    deadline = time.monotonic() + 300
    report_root.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, 4):
        argv = list(command)
        if attempt > 1 and "-U" not in argv:
            # Maven caches failed artifact resolutions. Force the retry to
            # contact the same configured repository instead of reusing it.
            argv.insert(1, "-U")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Maven warmup exceeded its 300-second budget")
        log = report_root / f"maven-single-attempt-{attempt}.log"
        try:
            result = subprocess.run(
                argv, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=remaining,
            )
        except subprocess.TimeoutExpired as exc:
            log.write_text(
                f"command: {argv!r}\nstatus: timeout\n{_text(exc.stdout)}\n{_text(exc.stderr)}",
                encoding="utf-8",
            )
            raise
        output = result.stdout + "\n" + result.stderr
        log.write_text(f"command: {argv!r}\nexit_code: {result.returncode}\n{output}", encoding="utf-8")
        if result.returncode == 0:
            return (result.stdout + result.stderr).strip()
        failure = RuntimeError(f"{argv[0]} failed: {result.stdout[-2000:]} {result.stderr[-2000:]}")
        delay = float(attempt)
        if (attempt == 3 or not _TRANSFER.search(output) or not _TRANSIENT.search(output)
                or deadline - time.monotonic() <= delay):
            raise failure
        print(f"Maven repository transfer failed; retry {attempt + 1}/3 in {delay:g}s; log: {log}", flush=True)
        time.sleep(delay)
    raise AssertionError("unreachable")
