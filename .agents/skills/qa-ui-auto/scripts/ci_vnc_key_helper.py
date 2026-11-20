"""Verify startup and parent-pipe ownership for the actual Windows QA helper."""

import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import threading

from native_build import qa_binary, verify_identity


def observe(release: bool, receipt: Path) -> None:
    app = qa_binary(release=release)
    identity = verify_identity(app)
    helper = app.with_name("taomni-vnc-key-helper.exe")
    startup = {"creationflags": subprocess.CREATE_NO_WINDOW}
    command = [str(helper), str(os.getpid())]
    invalid = subprocess.run([str(helper)], capture_output=True, timeout=15, **startup)
    if invalid.returncode != 2:
        raise RuntimeError(f"Expected invalid launch to exit 2, got {invalid.returncode}")

    # An owner can exit before the helper reaches its message loop.
    early = subprocess.run(command, input=b"", capture_output=True, timeout=15, **startup)
    if early.returncode != 0:
        raise RuntimeError(f"Early owner-pipe EOF returned {early.returncode}")

    with subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, **startup,
    ) as process:
        replies: queue.Queue[str] = queue.Queue(maxsize=1)
        reader = threading.Thread(target=lambda: replies.put(process.stdout.readline()), daemon=True)
        reader.start()
        try:
            diagnostic = replies.get(timeout=15).strip()
            if not diagnostic.startswith("n ") or process.poll() is not None:
                raise RuntimeError(f"VNC helper did not start its diagnostic stream: {diagnostic!r}")
            process.stdin.write("on\noff\n")
            process.stdin.flush()
            process.stdin.close()
            code = process.wait(timeout=15)
            if code != 0:
                raise RuntimeError(f"VNC helper did not exit cleanly after owner-pipe EOF: {code}")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=15)
            reader.join(timeout=15)

    receipt.write_text(json.dumps({
        "sourceSha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "runnerImage": os.environ.get("ImageVersion"),
        "profile": identity["profile"],
        "appSha256": identity["binary_sha256"],
        "helperSha256": identity["vnc_key_helper_sha256"],
        "invalidLaunchExit": invalid.returncode,
        "earlyOwnerExit": early.returncode,
        "ownerExit": code,
    }, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()
    observe(args.release, args.receipt)
