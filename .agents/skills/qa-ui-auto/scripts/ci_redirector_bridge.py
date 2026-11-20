"""Check the installed QA Redirector helper stops while awaiting its provider."""

import argparse
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import tempfile
import time
import uuid

from native_build import qa_binary, verify_identity


def observe(release: bool, receipt: Path) -> None:
    app = qa_binary(release=release)
    identity = verify_identity(app)
    helper = app.with_name("sockscap-redirector-bridge")
    invalid = subprocess.run([str(helper)], capture_output=True, text=True, timeout=15)
    if invalid.returncode != 1 or "missing --provider-socket" not in invalid.stderr:
        raise RuntimeError(f"Bridge accepted unconfigured launch: {invalid.returncode}: {invalid.stderr}")

    suffix = uuid.uuid4().hex
    provider = Path(f"/tmp/taomni-redirector-qa-provider-{suffix}.sock")
    flow = Path(f"/tmp/taomni-redirector-qa-flow-{suffix}.sock")
    launcher_pid = None
    with tempfile.TemporaryDirectory(prefix="taomni-bridge-qa-") as temp:
        root = Path(temp)
        launcher = root / "waiting-redirector"
        ready = root / "launcher.pid"
        launcher.write_text(
            f'#!/bin/sh\nprintf "%s\\n" "$$" > {shlex.quote(str(ready))}\nexec /bin/sleep 60\n',
            encoding="utf-8",
        )
        launcher.chmod(0o700)
        with subprocess.Popen(["/bin/sleep", "60"]) as owner:
            command = [str(helper), "--provider-socket", str(provider), "--flow-socket", str(flow),
                       "--redirector", str(launcher), "--parent-pid", str(owner.pid)]
            with subprocess.Popen(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, start_new_session=True,
            ) as bridge:
                try:
                    deadline = time.monotonic() + 15
                    while not (provider.is_socket() and ready.is_file()):
                        if bridge.poll() is not None or time.monotonic() >= deadline:
                            raise RuntimeError("Redirector bridge did not reach its approval wait")
                        time.sleep(0.05)
                    launcher_pid = int(ready.read_text())
                    owner.terminate()
                    owner.wait(timeout=5)
                    _, stderr = bridge.communicate(timeout=15)
                    owner_exit = bridge.returncode
                    if owner_exit != 1 or "exited while waiting for Redirector approval" not in stderr:
                        raise RuntimeError(f"Bridge did not follow the owner exit: {owner_exit}: {stderr}")
                    if provider.exists() or flow.exists():
                        raise RuntimeError("Bridge left its private socket behind")
                    try:
                        os.kill(launcher_pid, 0)
                    except ProcessLookupError:
                        pass
                    else:
                        raise RuntimeError("Bridge left its waiting launcher running")
                finally:
                    if owner.poll() is None:
                        owner.kill()
                        owner.wait(timeout=5)
                    if bridge.poll() is None:
                        os.killpg(bridge.pid, signal.SIGKILL)
                        bridge.wait(timeout=5)
                    provider.unlink(missing_ok=True)
                    flow.unlink(missing_ok=True)

    receipt.write_text(json.dumps({
        "sourceSha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "runnerImage": os.environ.get("ImageVersion"),
        "profile": identity["profile"],
        "appSha256": identity["binary_sha256"],
        "helperSha256": identity["redirector_bridge_sha256"],
        "unconfiguredLaunchExit": invalid.returncode,
        "ownerExitDuringApproval": owner_exit,
        "launcherReaped": True,
        "privateSocketsRemoved": True,
    }, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()
    observe(args.release, args.receipt)
