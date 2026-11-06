"""Ready a real, job-owned file manager for the minimal Openbox desktop."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
from typing import Callable


SERVICE = "org.pcmanfm.PCManFM"
HANDLER = "pcmanfm-qt.desktop"


def prepare_file_manager(root: Path, start: Callable, wait: Callable) -> dict:
    root.mkdir(parents=True, exist_ok=False)
    roots = {}
    for key, directory in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                           ("XDG_CACHE_HOME", "cache")):
        path = root / directory
        path.mkdir()
        roots[key] = str(path)
    config = Path(roots["XDG_CONFIG_HOME"])
    (config / "mimeapps.list").write_text(
        "[Default Applications]\ninode/directory=" + HANDLER + ";\n", encoding="utf-8")
    # Case isolation replaces XDG_CONFIG_HOME. Supply only the directory
    # association as a job-owned fallback, without changing any host/app config
    # or HTTP(S) associations. Desktop restores this variable during cleanup.
    before = os.environ.get("XDG_CONFIG_DIRS", "/etc/xdg")
    os.environ["XDG_CONFIG_DIRS"] = str(config) + os.pathsep + before
    environment = {**os.environ, **roots, "QT_QPA_PLATFORM": "xcb"}
    process = start(["pcmanfm-qt", "--daemon-mode"], env=environment)

    def owns_service():
        result = subprocess.run([
            "gdbus", "call", "--session", "--dest", "org.freedesktop.DBus",
            "--object-path", "/org/freedesktop/DBus", "--method",
            "org.freedesktop.DBus.GetConnectionUnixProcessID", SERVICE,
        ], capture_output=True, text=True, timeout=5, check=True, env=environment)
        return re.fullmatch(r"\(uint32\s+" + str(process.pid) + r",\)\s*", result.stdout) is not None

    wait(process, owns_service, "job-owned file manager")
    # Query through an empty app root to verify the fallback survives native
    # per-case XDG isolation rather than accidentally reading the daemon config.
    application = root / "app-config-probe"
    application.mkdir()
    result = subprocess.run(["xdg-mime", "query", "default", "inode/directory"],
                            capture_output=True, text=True, timeout=5, check=True,
                            env={**environment, "XDG_CONFIG_HOME": str(application)})
    if result.stdout.strip() != HANDLER:
        raise RuntimeError("job-owned directory association was not selected")
    return {"pid": process.pid, "service": SERVICE, "handler": HANDLER,
            "association_config": str(config), "ready": True}
