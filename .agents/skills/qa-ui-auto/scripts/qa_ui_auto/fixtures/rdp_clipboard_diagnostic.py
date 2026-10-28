"""Temporary read-only sampling of the owned macOS QA app during joint copy.

This diagnostic neither writes the clipboard nor changes the case assertions.
The resulting stacks are diagnostic evidence, never functional pass evidence.
"""
from __future__ import annotations

import json
from pathlib import Path
import platform
import subprocess
import threading

from .. import host_clipboard


def owned_pid(application: Path) -> int:
    output = subprocess.check_output(["ps", "-axo", "pid=,comm="], text=True, timeout=5)
    matches = []
    for line in output.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) == 2 and Path(fields[1]).resolve() == application.resolve():
            matches.append(int(fields[0]))
    if len(matches) != 1:
        raise RuntimeError(f"Expected one process for the verified QA executable, got {matches}")
    return matches[0]


def setup(ctx) -> None:
    if platform.system() != "Darwin":
        return
    from native_build import verify_identity
    from tauri_webdriver import native_binary

    application = native_binary(ctx.cfg).resolve()
    identity = verify_identity(application)
    if identity.get("identifier") != "com.taomni.app.qa":
        raise RuntimeError("Thread sampling requires the verified isolated QA application")
    case_dir = Path(ctx.case_dir).resolve()
    stopped = threading.Event()
    state = {"application": str(application), "observedCopy": False, "sampled": False}

    def observe():
        try:
            while not stopped.wait(.25):
                if host_clipboard.get_text() != "joint-clipboard 联合 ✓ no-echo":
                    continue
                state["observedCopy"] = True
                state["pid"] = owned_pid(application)
                result = subprocess.run(
                    ["sample", str(state["pid"]), "2", "10", "-file", str(case_dir / "clipboard-native-stacks.txt")],
                    capture_output=True, text=True, timeout=10,
                )
                state.update(sampled=result.returncode == 0, sampleExit=result.returncode,
                             sampleError=result.stderr[-1000:])
                return
        except Exception as error:
            state["error"] = f"{type(error).__name__}: {error}"
        finally:
            (case_dir / "clipboard-native-diagnostic.json").write_text(json.dumps(state, indent=2) + "\n")

    thread = threading.Thread(target=observe, name="qa-rdp-clipboard-diagnostic", daemon=True)
    ctx._rdp_clipboard_diagnostic = (stopped, thread)
    thread.start()


def teardown(ctx) -> None:
    owner = getattr(ctx, "_rdp_clipboard_diagnostic", None)
    if owner:
        stopped, thread = owner
        stopped.set()
        thread.join(timeout=12)
        if thread.is_alive():
            raise RuntimeError("Owned clipboard sampling thread failed to stop")
