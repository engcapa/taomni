"""Disposable Linux xrdp/Xorg reference session, owned by a hosted QA case.

Packages are installed by the workflow. Setup changes are restored even when
provisioning fails. No service/account mutation is allowed on a workstation.
"""
from __future__ import annotations

import os
import json
import platform
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

_STATE: dict[str, Any] = {}


def _sudo(*args: str, input: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    # The supervisor runs as root too: killing sudo alone can leave useradd or
    # its hooks alive, holding account locks after Python's timeout expires.
    result = subprocess.run(["sudo", "-n", "timeout", "--signal=TERM", "--kill-after=5",
                             "90", *args], input=input, capture_output=True,
                            text=True, timeout=100)
    if check and result.returncode:
        raise RuntimeError(f"xrdp fixture: {args[0]} failed ({result.returncode}): {result.stderr[-500:]}")
    return result


def _create_user(ctx: Any, user: str) -> None:
    # Claim this unique, absent account before the command: a post-create hook
    # can hang after passwd has already been written. Teardown must remove it.
    if any(line.split(":", 1)[0] == user for line in Path("/etc/passwd").read_text().splitlines()):
        raise RuntimeError("xrdp fixture account already exists")
    _STATE["user"] = user
    # Hosted images put Rust/.NET toolchains in /etc/skel. Copying that tree can
    # exceed the setup budget. This session supplies its own .xsession below.
    with tempfile.TemporaryDirectory(prefix="taomni-xrdp-skel-") as skeleton:
        command = ["useradd", "-m", "--skel", skeleton, "-s", "/bin/bash", user]
        if (case_dir := getattr(ctx, "case_dir", None)) is not None and shutil.which("strace"):
            diagnostics = Path(case_dir) / "xrdp-diagnostics"
            diagnostics.mkdir(parents=True, exist_ok=True)
            # Exclude read/write/send/recv payloads and environment strings. This
            # distinguishes locks, NSS and post-create hooks without credential data.
            command = ["strace", "-f", "-tt", "-s", "80", "-e",
                       "trace=%process,%file,connect,poll,ppoll,futex", "-o",
                       str((diagnostics / "create-user.trace").resolve()), *command]
        _sudo(*command)


def configure_xrdp(text: str, port: int) -> str:
    """Change only Globals; transport-specific port=-1 entries remain intact."""
    if not 1 <= port <= 65535:
        raise ValueError("invalid xrdp port")
    sections = re.split(r"(?m)^(?=\[)", text)
    for index, section in enumerate(sections):
        if section.startswith("[Globals]"):
            section = re.sub(r"(?m)^port=.*$", f"port=tcp://127.0.0.1:{port}", section)
            section = re.sub(r"(?m)^autorun=.*$", "autorun=Xorg", section)
            sections[index] = section
            break
    else:
        raise RuntimeError("xrdp.ini has no Globals section")
    return "".join(sections)


def _export(ctx: Any, key: str, value: str) -> None:
    _STATE.setdefault("previous_env", {})[key] = os.environ.get(key)
    os.environ[key] = value
    if isinstance(getattr(ctx, "env", None), dict):
        ctx.env[key] = value


def setup(ctx: Any) -> None:
    if platform.system() != "Linux" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("xrdp reference provisioning requires a Linux GitHub hosted runner")
    if not all(shutil.which(tool) for tool in ("xrdp", "Xorg", "openbox-session")):
        raise RuntimeError("xrdp/xorgxrdp/openbox packages were not provisioned by CI")
    if _STATE:
        raise RuntimeError("another xrdp fixture owns the service")
    config = Path("/etc/xrdp/xrdp.ini")
    _STATE["config"] = config.read_bytes()
    _STATE["active"] = {name: _sudo("systemctl", "is-active", name, check=False).returncode == 0 for name in ("xrdp", "xrdp-sesman")}
    user = "qaxrdp" + secrets.token_hex(4)
    password = "Qa1_" + secrets.token_hex(16)
    print(f"::add-mask::{password}", flush=True)
    try:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        _sudo("systemctl", "stop", "xrdp", "xrdp-sesman")
        _create_user(ctx, user)
        _sudo("chpasswd", input=f"{user}:{password}\n")
        groups = subprocess.run(["id", "-nG", "xrdp"], capture_output=True, text=True, check=True).stdout.split()
        if "ssl-cert" not in groups:
            _sudo("usermod", "-aG", "ssl-cert", "xrdp")
            _STATE["added_ssl_group"] = True
        directory = tempfile.TemporaryDirectory(prefix="taomni-xrdp-")
        _STATE["directory"] = directory
        root = Path(directory.name)
        root.chmod(0o755)
        state_dir = root / "session"
        state_dir.mkdir(mode=0o777)
        state_dir.chmod(0o777)
        _sudo("chown", user, str(state_dir))
        helper = root / "rdp_target.py"
        shutil.copy2(Path(__file__).resolve().parents[1] / "rdp_helpers" / "rdp_target.py", helper)
        target = [sys.executable, str(helper), "--mode", "flip", "--pattern", "--geometry", "480x320+40+80", "--state", str(state_dir / "flip-state.json")]
        xsession = ("#!/bin/sh\n"
                    "unset DBUS_SESSION_BUS_ADDRESS SESSION_MANAGER\n"
                    "openbox-session &\n"
                    + shlex.join(target) + " >" + shlex.quote(str(state_dir / "target.log")) + " 2>&1 &\n"
                    "wait\n")
        _sudo("tee", f"/home/{user}/.xsession", input=xsession)
        _sudo("chmod", "755", f"/home/{user}/.xsession")
        _sudo("chown", user, f"/home/{user}/.xsession")
        updated = configure_xrdp(_STATE["config"].decode(), port)
        _sudo("tee", str(config), input=updated)
        _sudo("systemctl", "start", "xrdp-sesman", "xrdp")
        deadline = time.monotonic() + 30
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("xrdp never listened on its disposable loopback port")
                time.sleep(0.25)
        _export(ctx, "QA_XRDP_USER", user)
        _export(ctx, "QA_XRDP_PASSWORD", password)
        _export(ctx, "QA_XRDP_PORT", str(port))
        _export(ctx, "QA_RDP_XRDP_DIR", str(state_dir))
        _export(ctx, "TAOMNI_QA_RDP_TRACE", "1")
    except BaseException:
        teardown(ctx)
        raise


def teardown(ctx: Any) -> None:
    if not _STATE:
        return
    _collect_diagnostics(ctx)
    _sudo("systemctl", "stop", "xrdp", "xrdp-sesman", check=False)
    user = _STATE.get("user")
    if user:
        _sudo("pkill", "-KILL", "-u", user, check=False)
        _sudo("userdel", "-r", user, check=False)
    if "config" in _STATE:
        _sudo("tee", "/etc/xrdp/xrdp.ini", input=_STATE["config"].decode(), check=False)
    if _STATE.get("added_ssl_group"):
        _sudo("gpasswd", "-d", "xrdp", "ssl-cert", check=False)
    for name, active in _STATE.get("active", {}).items():
        if active:
            _sudo("systemctl", "start", name, check=False)
    if "directory" in _STATE:
        _STATE["directory"].cleanup()
    for key, value in _STATE.get("previous_env", {}).items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    _STATE.clear()


def _collect_diagnostics(ctx: Any) -> None:
    """Preserve the session's failure before services and account are removed."""
    case_dir = getattr(ctx, "case_dir", None)
    if case_dir is None:
        return
    destination = Path(case_dir) / "xrdp-diagnostics"
    try:
        destination.mkdir(parents=True, exist_ok=True)
        password = os.environ.get("QA_XRDP_PASSWORD", "")
        files = [("xrdp.log", "/var/log/xrdp.log"), ("sesman.log", "/var/log/xrdp-sesman.log")]
        if user := _STATE.get("user"):
            files.extend([("xsession.log", f"/home/{user}/.xsession-errors"),
                          ("xorg.log", f"/home/{user}/.xorgxrdp.10.log")])
        for name, path in files:
            result = _sudo("tail", "-c", "100000", path, check=False)
            detail = result.stdout + result.stderr
            if password:
                detail = detail.replace(password, "[redacted]")
            (destination / name).write_text(detail, encoding="utf-8")
        result = _sudo("journalctl", "-u", "xrdp", "-u", "xrdp-sesman", "--no-pager", "-n", "300", check=False)
        detail = result.stdout + result.stderr
        if password:
            detail = detail.replace(password, "[redacted]")
        (destination / "services.log").write_text(detail, encoding="utf-8")
    except Exception as exc:
        # Optional diagnostics must never prevent ownership cleanup.
        try:
            (destination / "collection-error.json").write_text(json.dumps({"error": str(exc)}), encoding="utf-8")
        except OSError:
            pass
