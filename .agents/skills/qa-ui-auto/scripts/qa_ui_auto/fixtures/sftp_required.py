"""sftp_required: same as ssh_required but for the sftp section."""

from __future__ import annotations

import socket
import platform
from typing import Any


def setup(ctx: Any) -> None:
    cfg = getattr(ctx, "cfg", {}) or {}
    section = cfg.get("sftp") or {}
    remote_dir = section.get("remote_test_dir", "")
    ctx.values["sftp_shell_test_dir"] = section.get("remote_shell_test_dir", remote_dir)
    sftp_dir = remote_dir
    if platform.system() == "Windows" and remote_dir[:1].isalpha() and remote_dir[1:3] == ":/":
        sftp_dir = f"/{remote_dir}"
    ctx.values["sftp_sync_test_dir"] = section.get("remote_sftp_shell_test_dir", sftp_dir)
    ctx.values["sftp_chmod_mode"] = section.get("chmod_readback_mode", "644" if platform.system() == "Windows" else "600")
    ctx.values["sftp_chmod_status"] = ("chmod failed: remote server ignored requested permissions"
                                       if ctx.values["sftp_chmod_mode"] != "600" else "Permissions updated:")
    host = section.get("host")
    port = section.get("port")
    if not host or not port:
        from . import FixtureSkip
        raise FixtureSkip("sftp.host / sftp.port not set in qa-ui-auto.config.yaml")
    try:
        with socket.create_connection((host, int(port)), timeout=2.0):
            return
    except OSError as e:
        from . import FixtureSkip
        raise FixtureSkip(
            f"sftp server {host}:{port} unreachable ({e}). "
            "Fix the network/VPN/firewall — qa-ui-auto does not auto-fallback."
        ) from e
