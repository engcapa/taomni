"""Unlock only a hosted disposable Secret Service, never a developer's keyring."""
import os
import platform
import subprocess
from typing import Any


def setup(ctx: Any) -> None:
    if ((ctx.cfg.get("app") or {}).get("mode") != "native"
            or platform.system() != "Linux"
            or os.environ.get("GITHUB_ACTIONS") != "true"):
        return
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        raise RuntimeError("Native credential fixture requires the hosted private D-Bus session")
    subprocess.run(["gnome-keyring-daemon", "--unlock", "--components=secrets"],
                   input="qa-disposable-backup-keyring\n", text=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=20)
