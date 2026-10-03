"""Require an executable JDK and an installed JDTLS distribution for native cases."""
from __future__ import annotations

import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
from typing import Any


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    java = shutil.which("java")
    if not java:
        raise FixtureSkip("JDTLS requires JDK 21+ on PATH")
    version = subprocess.run([java, "-version"], capture_output=True, text=True, timeout=15)
    match = re.search(r'version "(\d+)', version.stderr + version.stdout)
    if version.returncode or not match or int(match.group(1)) < 21:
        raise FixtureSkip("JDTLS requires an executable JDK 21+")
    if (getattr(ctx, "cfg", {}).get("app") or {}).get("mode") != "native":
        return
    launcher = shutil.which("jdtls")
    if not launcher:
        raise FixtureSkip("native Java provider requires jdtls on PATH")
    raw = os.environ.get("JDTLS_HOME")
    if raw:
        home = Path(raw)
        suffix = {"Linux": "linux", "Windows": "win", "Darwin": "mac"}[platform.system()]
        if platform.machine().lower() in {"arm64", "aarch64"}:
            suffix += "_arm"
        if not list((home / "plugins").glob("org.eclipse.equinox.launcher*.jar")) or not (home / ("config_" + suffix)).is_dir():
            raise FixtureSkip(f"incomplete JDTLS distribution for {platform.system()}/{platform.machine()}")
    # CI also sends initialize and checks capabilities before launching the app.
    # Actual semantic assertions remain in each selected native case.
