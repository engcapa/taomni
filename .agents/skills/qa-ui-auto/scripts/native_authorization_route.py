"""Case-owned system URL association that launches a real, private browser."""
from __future__ import annotations

import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys


def desktop_argument(value: str) -> str:
    if any(character in value for character in "\r\n"):
        raise ValueError("Desktop launcher path contains a newline")
    escaped = value.replace("\\", "\\\\\\\\").replace('"', '\\\\"')
    for character in ("`", "$"):
        escaped = escaped.replace(character, "\\\\" + character)
    return '"' + escaped.replace("%", "%%") + '"'


class AuthorizationBrowserRoute:
    def __init__(self, case_dir: Path, expected: dict[str, str]):
        case_dir = case_dir.resolve()
        if (set(expected) != {"XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"}
                or any(not Path(value).resolve().is_relative_to(case_dir.parent) for value in expected.values())):
            raise RuntimeError("Authorization route refuses non-run-owned XDG roots")
        self.root = case_dir / "authorization-browser"
        self.expected = expected
        # Browser cookies/cache stay under the profile tree excluded from hosted
        # artifacts, not beside the public launcher/cleanup evidence.
        self.profile = Path(expected["XDG_CACHE_HOME"]) / "authorization-browser" / case_dir.name
        self.record = self.root / "launch.json"
        self.before = {}
        self.handler = None

    def install(self):
        if os.environ.get("GITHUB_ACTIONS") != "true" or sys.platform != "linux":
            raise RuntimeError("Authorization browser association is hosted Linux QA only")
        if any(os.environ.get(key) != value for key, value in self.expected.items()):
            raise RuntimeError("Authorization browser association requires active XDG isolation")
        if self.root.exists():
            raise RuntimeError("Authorization browser route must start in a fresh case directory")
        browser = next((path for name in ("google-chrome", "chromium", "chromium-browser", "firefox")
                        if (path := shutil.which(name))), None)
        if browser is None:
            raise RuntimeError("No real system browser available for authorization")
        self.root.mkdir(parents=True)
        self.profile.mkdir(parents=True)
        (self.profile / ".taomni-qa-browser").write_text("owned authorization fixture\n")
        launcher = self.root / "open-browser.sh"
        script = Path(__file__).with_name("native_authorization_browser.py").resolve()
        argv = [sys.executable, "-I", str(script), "--browser", browser,
                "--profile", str(self.profile), "--record", str(self.record),
                "--cache-root", self.expected["XDG_CACHE_HOME"]]
        launcher.write_text("#!/bin/sh\nexec " + shlex.join(argv) + ' "$1"\n', encoding="utf-8")
        launcher.chmod(0o700)
        data = Path(self.expected["XDG_DATA_HOME"]) / "applications"
        config = Path(self.expected["XDG_CONFIG_HOME"])
        data.mkdir(parents=True, exist_ok=True)
        config.mkdir(parents=True, exist_ok=True)
        handler = data / "taomni-qa-authorization.desktop"
        if handler.exists():
            raise RuntimeError("Authorization handler already exists in this run")
        self.handler = handler
        self.handler.write_text(
            "[Desktop Entry]\nType=Application\nName=QA authorization browser\n"
            "NoDisplay=true\nTerminal=false\nExec=" + desktop_argument(str(launcher))
            + " %u\nMimeType=x-scheme-handler/https;x-scheme-handler/http;\n", encoding="utf-8")
        for path in (config / "mimeapps.list", data / "mimeapps.list"):
            self.before[path] = path.read_bytes() if path.exists() else None
        for mime in ("x-scheme-handler/https", "x-scheme-handler/http"):
            subprocess.run(["xdg-mime", "default", self.handler.name, mime],
                           capture_output=True, text=True, timeout=5, check=True)
            actual = subprocess.run(["xdg-mime", "query", "default", mime],
                                    capture_output=True, text=True, timeout=5, check=True)
            if actual.stdout.strip() != self.handler.name:
                raise RuntimeError("Run-owned authorization browser association was not selected")

    def restore(self):
        for path, previous in self.before.items():
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(previous)
        if self.handler is not None:
            self.handler.unlink(missing_ok=True)
