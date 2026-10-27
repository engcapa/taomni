"""Browser case lifetime and exclusive access to a shared mutable VNC fixture."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import tempfile
import time
from typing import Callable, Iterator


@contextmanager
def fixture_access(payload: dict) -> Iterator[None]:
    """VNC reset/log/watch affect the whole server, so serialize its consumers.

    Wait before starting the case's deadline. OS file locks release even when a
    worker crashes. Other fixtures/cases keep their normal browser parallelism.
    """
    if payload.get("dry_run") or "vnc_required" not in payload["case"].get("fixtures", []):
        yield
        return
    vnc = payload["cfg"].get("vnc") or {}
    key = str((vnc.get("host"), vnc.get("port"), vnc.get("control_port")))
    digest = hashlib.sha256(key.encode()).hexdigest()
    lock_path = Path(tempfile.gettempdir()) / f"taomni-qa-vnc-{digest}.lock"
    with lock_path.open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            if lock.tell() == 0:
                lock.write(b"0")
                lock.flush()
            while True:
                lock.seek(0)
                try:
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(0.1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def run_browser_case(payload: dict, execute: Callable[[dict], dict]) -> dict:
    started = time.monotonic()
    try:
        with fixture_access(payload):
            return execute(payload)
    except Exception as exc:
        case = payload["case"]
        return {"id": case["id"], "title": case["title"], "tags": case["tags"],
                "covers": case["covers"], "modes": case["modes"], "status": "failed",
                "duration_sec": time.monotonic() - started, "step_count": len(case["steps"]),
                "failure": {"step_index": 0, "verb": "<setup>", "message": str(exc), "artifacts": {}}}
