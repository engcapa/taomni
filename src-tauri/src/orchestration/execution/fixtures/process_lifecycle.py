"""Owned native process-lifecycle fixture, never a coding-worker substitute.

Only hosted ignored Rust tests launch this file. The sleeping descendant keeps
its assigned process group but closes stdio, exercising cleanup after leader exit.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("leader", "cancel", "descendant"))
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if os.environ.get("GITHUB_ACTIONS") != "true" or not (root / "owned-native-test").is_file():
        raise RuntimeError("process fixture requires hosted execution and an owned test directory")
    if args.mode == "descendant":
        def stop(_signal, _frame):
            (root / "descendant-stopped").write_text(str(os.getpid()), encoding="utf-8")
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, stop)
        (root / "descendant-pid").write_text(str(os.getpid()), encoding="utf-8")
        # Bounded even if the owning test process crashes before cleanup.
        time.sleep(60)
        return
    subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "descendant", str(root)],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 5
    while not (root / "descendant-pid").is_file():
        if time.monotonic() >= deadline:
            raise RuntimeError("descendant did not become ready")
        time.sleep(0.01)
    if args.mode == "cancel":
        time.sleep(60)
        return
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                      "result": "Native lifecycle fixture completed; this is not coding or model evidence."}), flush=True)


if __name__ == "__main__":
    main()
