"""Retry transient Maven repository transfers within the original warmup budget."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import time
from typing import Sequence

# Both the legacy Wagon transporter and the Maven Resolver HTTP transporter read
# their own retry settings. Setting both keeps the retry policy effective on
# Maven 3.8 (Wagon) and Maven 3.9+ (Resolver), and is harmless on either.
MAVEN_RETRY_OPTIONS = (
    "-Dmaven.wagon.http.retryHandler.count=5",
    "-Daether.connector.http.retryHandler.count=5",
    "-Daether.connector.http.retryHandler.interval=2000",
    "-Daether.connector.http.retryHandler.intervalMax=10000",
)
RETRY_DELAYS = (5.0, 15.0)
DEFAULT_BUDGET_SECONDS = 600.0
DEFAULT_ATTEMPT_TIMEOUT_SECONDS = 240.0

# Maven reports failed downloads differently from Gradle; both are covered so
# the same classifier protects warmup and fixture builds.
_TRANSFER = re.compile(
    r"could not transfer(?: artifact| metadata)?|could not resolve|could not download|"
    r"failed to transfer|unable to download",
    re.IGNORECASE,
)
_TRANSIENT = re.compile(
    r"(?:status code:|HTTP Status:)\s*(?:408|429|5\d\d)\b|(?:read|connect(?:ion)?) timed out|"
    r"connection reset|temporary failure in name resolution|connection refused|"
    r"too many requests|service unavailable",
    re.IGNORECASE,
)


def _text(value: str | bytes | None) -> str:
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value or ""


def transient_failure(output: str) -> bool:
    """Return True only for a failed repository transfer that is worth retrying."""
    return bool(_TRANSFER.search(output) and _TRANSIENT.search(output))


def with_maven_options(command: Sequence[str]) -> list[str]:
    """Add HTTP retry options to a Maven command without duplicating options."""
    argv = list(command)
    if not argv or not Path(argv[0]).name.lower().startswith("mvn"):
        return argv
    if any(option in argv for option in MAVEN_RETRY_OPTIONS):
        return argv
    return [argv[0], *MAVEN_RETRY_OPTIONS, *argv[1:]]


def with_forced_update(command: Sequence[str]) -> list[str]:
    """Add ``-U`` to a Maven command so a cached failed resolution is retried."""
    argv = list(command)
    if not argv or not Path(argv[0]).name.lower().startswith("mvn") or "-U" in argv:
        return argv
    return [argv[0], "-U", *argv[1:]]


def _env_seconds(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def warm_maven(command: Sequence[str], cwd: Path, report_root: Path) -> str:
    """Keep permanent/build errors fatal; retry failed repository transfers.

    Transient failures include HTTP 408/429/5xx, connection resets and slow
    transfers that reach the per-attempt timeout. Each retry asks Maven to
    re-resolve remotely (``-U``) because a failed artifact resolution is cached
    in the local repository. Retries share one bounded budget so a persistent
    outage cannot stretch a job indefinitely.
    """
    budget = _env_seconds("QA_MAVEN_WARMUP_BUDGET", DEFAULT_BUDGET_SECONDS)
    attempt_timeout = _env_seconds("QA_MAVEN_ATTEMPT_TIMEOUT", DEFAULT_ATTEMPT_TIMEOUT_SECONDS)
    deadline = time.monotonic() + budget
    report_root.mkdir(parents=True, exist_ok=True)
    base = with_maven_options(command)
    attempts = len(RETRY_DELAYS) + 1
    for attempt in range(1, attempts + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 1.0:
            raise RuntimeError(f"Maven warmup exceeded its {budget:g}-second budget")
        # Maven caches failed artifact resolutions. Force each retry to contact
        # the same configured repository instead of reusing the cached failure.
        argv = with_forced_update(base) if attempt > 1 else list(base)
        timeout = min(attempt_timeout, remaining)
        log = report_root / f"maven-single-attempt-{attempt}.log"
        transient = False
        try:
            result = subprocess.run(
                argv, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            output = _text(exc.stdout) + "\n" + _text(exc.stderr)
            log.write_text(
                f"command: {argv!r}\nstatus: timeout after {timeout:g}s\n{output}",
                encoding="utf-8",
            )
            failure = RuntimeError(
                f"{argv[0]} timed out after {timeout:g}s: {output[-2000:]}"
            )
            transient = True
        else:
            output = result.stdout + "\n" + result.stderr
            log.write_text(f"command: {argv!r}\nexit_code: {result.returncode}\n{output}",
                           encoding="utf-8")
            if result.returncode == 0:
                return (result.stdout + result.stderr).strip()
            failure = RuntimeError(
                f"{argv[0]} failed: {result.stdout[-2000:]} {result.stderr[-2000:]}"
            )
            transient = transient_failure(output)
        delay = RETRY_DELAYS[attempt - 1] if attempt <= len(RETRY_DELAYS) else 0.0
        if (attempt >= attempts or not transient
                or deadline - time.monotonic() <= delay):
            raise failure
        print(f"Maven repository transfer failed; retry {attempt + 1}/{attempts} in "
              f"{delay:g}s; log: {log}", flush=True)
        time.sleep(delay)
    raise AssertionError("unreachable")
