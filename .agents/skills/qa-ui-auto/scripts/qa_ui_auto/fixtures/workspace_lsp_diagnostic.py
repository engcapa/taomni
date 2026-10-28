"""Read-only macOS sampling while the real fixture peer holds initialize.

This records diagnostic stacks and process lifetime. It never opens the gate,
changes the clipboard, or replaces the case's production-path assertions.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import subprocess
import threading
import time


def owned_pid(application: Path) -> int:
    output = subprocess.check_output(["ps", "-axo", "pid=,comm="], text=True, timeout=5)
    matches = []
    for line in output.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) == 2 and Path(fields[1]).resolve() == application.resolve():
            matches.append(int(fields[0]))
    if len(matches) != 1:
        raise RuntimeError(f"Expected one verified QA process, got {matches}")
    return matches[0]


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def setup(ctx, events: Path) -> None:
    if platform.system() != "Darwin":
        return
    from native_build import verify_identity
    from tauri_webdriver import native_binary

    application = native_binary(ctx.cfg).resolve()
    if verify_identity(application).get("identifier") != "com.taomni.app.qa":
        raise RuntimeError("LSP sampling requires the verified isolated QA application")
    destination = Path(ctx.case_dir).resolve()
    stopped = threading.Event()
    state = {"application": str(application), "observations": [], "samples": []}

    def save():
        (destination / "lsp-native-diagnostic.json").write_text(json.dumps(state, indent=2) + "\n")

    def observe():
        try:
            while not stopped.wait(.05):
                if events.exists() and "initialize-blocked" in events.read_text():
                    break
            else:
                return
            app_pid = owned_pid(application)
            peer = json.loads(events.with_suffix(".process.json").read_text())
            if peer["parent"] != app_pid:
                raise RuntimeError("The held peer is not a direct child of the verified QA process")
            state.update(pid=app_pid, peer=peer)
            start = time.monotonic()
            for index in range(3):
                if stopped.is_set():
                    break
                output = destination / f"lsp-native-stacks-{index}.txt"
                result = subprocess.run(["sample", str(app_pid), "2", "10", "-file", str(output)],
                                        capture_output=True, text=True, timeout=10)
                state["samples"].append({"at": time.monotonic() - start, "exit": result.returncode,
                                         "error": result.stderr[-1000:]})
                state["observations"].append({"at": time.monotonic() - start,
                                              "peerAlive": process_alive(peer["pid"]),
                                              "events": events.read_text()})
                save()
                if stopped.wait(3):
                    break
            while not stopped.wait(.25) and time.monotonic() - start < 90:
                alive = process_alive(peer["pid"])
                state["observations"].append({"at": time.monotonic() - start,
                                              "peerAlive": alive, "events": events.read_text()})
                save()
                if not alive or "didOpen:" in events.read_text():
                    return
        except Exception as error:
            state["error"] = f"{type(error).__name__}: {error}"
        finally:
            save()

    thread = threading.Thread(target=observe, name="qa-lsp-initialize-diagnostic", daemon=True)
    ctx._workspace_lsp_diagnostic = (stopped, thread)
    thread.start()


def teardown(ctx) -> None:
    owner = getattr(ctx, "_workspace_lsp_diagnostic", None)
    if owner:
        stopped, thread = owner
        stopped.set()
        thread.join(timeout=12)
        if thread.is_alive():
            raise RuntimeError("Owned LSP diagnostic thread failed to stop")
