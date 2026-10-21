"""Unlock only a hosted disposable Secret Service, never a developer's keyring."""
import json
import os
import platform
import secrets
import subprocess
import time
from pathlib import Path
from typing import Any

READINESS_TIMEOUT_SEC = 5.0
READINESS_RETRY_SEC = 0.1


def _failure(error: Exception) -> dict[str, Any]:
    return {
        "type": type(error).__name__,
        "returncode": getattr(error, "returncode", None),
        "stderr": str(getattr(error, "stderr", "") or "")[-4000:],
    }


def _roundtrip(attempt: dict[str, Any], token: str, deadline: float) -> None:
    def run(operation: str, *args: str, **extra: Any):
        attempt["operation"] = operation
        return subprocess.run(
            ["secret-tool", operation, *args], text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
            timeout=max(0.01, min(20.0, deadline - time.monotonic())), **extra,
        )

    try:
        run("store", "--label=Taomni QA readiness", "qa-readiness", token, input=token)
        actual = run("lookup", "qa-readiness", token)
        if actual.stdout.strip() != token:
            raise RuntimeError("Hosted Secret Service credential roundtrip differs")
    except Exception as error:
        attempt.update(status="failed", failed_operation=attempt["operation"], failure=_failure(error))
        try:
            run("clear", "qa-readiness", token)
        except Exception as cleanup_error:
            attempt["cleanup_failure"] = _failure(cleanup_error)
            error.add_note(f"Credential readiness cleanup also failed: {cleanup_error}")
        raise
    # A failed cleanup after a successful roundtrip must fail immediately.
    run("clear", "qa-readiness", token)
    attempt["status"] = "ready"


def setup(ctx: Any) -> None:
    if ((ctx.cfg.get("app") or {}).get("mode") != "native"
            or platform.system() != "Linux"
            or os.environ.get("GITHUB_ACTIONS") != "true"):
        return
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        raise RuntimeError("Native credential fixture requires the hosted private D-Bus session")
    # Desktop sessions may already have activated a locked daemon before the
    # native harness installed its run-owned XDG roots. Replace that service
    # on this disposable bus so unlock and the application use the same store.
    from tauri_webdriver import native_isolation_env
    expected = native_isolation_env(Path(ctx.report_root))
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Credential fixture requires run-owned native storage")
    trace: dict[str, Any] = {"schema": "qa.credential-readiness.v1", "attempts": [], "status": "starting"}
    primary_error: Exception | None = None
    try:
        # D-Bus was started before the native harness installed its XDG roots.
        # Any service activated during replacement must use this same store.
        subprocess.run(
            ["dbus-update-activation-environment", *expected], text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=20,
        )
        daemon = subprocess.run(
            ["gnome-keyring-daemon", "--replace", "--daemonize", "--unlock", "--components=secrets"],
            input="qa-disposable-backup-keyring\n", text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=20,
        )
        trace["daemon_stderr"] = str(getattr(daemon, "stderr", "") or "")[-4000:]
        # The daemon process exiting successfully does not establish writable
        # collection readiness. Wait for a real roundtrip on this private bus.
        deadline = time.monotonic() + READINESS_TIMEOUT_SEC
        token = secrets.token_hex(16)
        while True:
            attempt: dict[str, Any] = {}
            trace["attempts"].append(attempt)
            try:
                _roundtrip(attempt, token, deadline)
            except subprocess.CalledProcessError:
                # Only initial store/lookup readiness is polled. A successful
                # roundtrip with a failing cleanup is a terminal setup error.
                if attempt.get("status") != "failed" or time.monotonic() >= deadline:
                    raise
                time.sleep(min(READINESS_RETRY_SEC, max(0.0, deadline - time.monotonic())))
                continue
            trace["status"] = "ready"
            return
    except Exception as error:
        primary_error = error
        trace.update(status="failed", failure=_failure(error))
        raise
    finally:
        # Keep stderr even when setup fails before a native case directory is
        # created. Never record the probe value or lookup stdout.
        try:
            directory = Path(ctx.report_root) / "credential-store-readiness"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f"{time.time_ns()}.json").write_text(json.dumps(trace, indent=2) + "\n", encoding="utf-8")
        except OSError as diagnostics_error:
            if primary_error is None:
                raise
            primary_error.add_note(f"Credential readiness diagnostics also failed: {diagnostics_error}")
