#!/usr/bin/env python3
"""Enter a loopback-only namespace, drop root, and run a GitHub QA command.

Install dependencies before this step. This is a network boundary, not a file
sandbox. The executed command must be a trusted QA launcher with disposable HOME.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from receipts import assert_isolated_network


def display_environment(source: dict[str, str]) -> dict[str, str]:
    allowed = {}
    display = source.get("DISPLAY")
    if display:
        if not re.fullmatch(r"(?:unix/)?:[0-9]+(?:\.[0-9]+)?", display):
            raise ValueError("native QA accepts only a local Unix X11 display")
        allowed["DISPLAY"] = display
    auth = source.get("XAUTHORITY")
    if auth:
        path = Path(auth)
        if not path.is_absolute() or not path.is_file():
            raise ValueError("native QA XAUTHORITY must be an existing absolute file")
        allowed["XAUTHORITY"] = auth
    bus = source.get("DBUS_SESSION_BUS_ADDRESS")
    if bus:
        if not re.fullmatch(r"unix:(?:path|abstract)=[^;\n\r]+", bus):
            raise ValueError("native QA accepts only one Unix DBus session address")
        allowed["DBUS_SESSION_BUS_ADDRESS"] = bus
    return allowed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uid", required=True, type=int)
    parser.add_argument("--gid", required=True, type=int)
    parser.add_argument("--inside", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--allow-display", action="store_true",
                        help="Pass only local DISPLAY, XAUTHORITY and Unix DBUS_SESSION_BUS_ADDRESS for native QA")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or args.uid <= 0 or args.gid <= 0:
        parser.error("require a nonroot worker uid/gid and an explicit trusted command")
    if os.environ.get("GITHUB_ACTIONS") != "true" or sys.platform != "linux":
        parser.error("real worker namespaces are available only in Linux GitHub Actions")
    if os.geteuid() != 0:
        parser.error("use sudo; the command is dropped to the specified nonroot uid before execution")
    if not args.inside:
        unshare = shutil.which("unshare")
        if not unshare:
            parser.error("required util-linux unshare is not installed")
        display_flag = ["--allow-display"] if args.allow_display else []
        os.execv(unshare, [unshare, "--net", "--", sys.executable, "-I", str(Path(__file__).resolve()),
                          "--inside", "--uid", str(args.uid), "--gid", str(args.gid), *display_flag, "--", *command])
    try:
        assert_isolated_network()
    except RuntimeError as exc:
        parser.error(str(exc))
    ip = shutil.which("ip")
    if not ip:
        parser.error("required iproute2 ip is not installed")
    subprocess.run([ip, "link", "set", "lo", "up"], check=True, timeout=10)
    os.setgroups([])
    os.setgid(args.gid)
    os.setuid(args.uid)
    # Clear sudo's residual credentials, environment and proxy configuration.
    # The QA launcher supplies its own HOME per worker and uses absolute files.
    env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
           "GITHUB_ACTIONS": "true", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    if args.allow_display:
        env.update(display_environment(os.environ))
    os.execvpe(command[0], command, env)


if __name__ == "__main__":
    main()
