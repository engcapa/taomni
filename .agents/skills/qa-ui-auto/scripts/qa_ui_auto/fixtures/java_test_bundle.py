"""Resolve an installed java-test extension for native provider cases.

The packaged app does not download editor extensions. Native cases that assert
java-test-backed discovery therefore need a real local extension and must
report an environment skip when it is unavailable.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


JAVA_TEST_PREFIX = "com.microsoft.java.test.plugin-"
JAVA_DEBUG_PREFIX = "com.microsoft.java.debug.plugin-"
EDITOR_EXTENSION_ROOTS = (
    ".vscode/extensions",
    ".vscode-insiders/extensions",
    ".vscode-server/extensions",
    ".cursor/extensions",
    ".vscode-oss/extensions",
    ".windsurf/extensions",
)


def _version_key(name: str) -> tuple[int, ...]:
    raw = name.rsplit("-", 1)[-1].removesuffix(".jar")
    return tuple(int(part) if part.isdigit() else 0 for part in raw.replace("_", ".").split("."))


def _latest_jar(directory: Path, prefix: str) -> Path | None:
    matches = [
        path
        for path in directory.glob(f"{prefix}*.jar")
        if path.is_file() and path.name.startswith(prefix)
    ]
    return max(matches, key=lambda path: _version_key(path.name), default=None)


def _configured_path(env_name: str, prefix: str) -> Path | None:
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    if path.is_file() and path.name.startswith(prefix):
        return path
    if path.is_dir():
        return _latest_jar(path, prefix)
    return None


def _discover(prefix: str, env_name: str) -> Path | None:
    configured = _configured_path(env_name, prefix)
    if configured:
        return configured
    home = Path.home()
    candidates: list[Path] = []
    for relative_root in EDITOR_EXTENSION_ROOTS:
        root = home / relative_root
        if not root.is_dir():
            continue
        for extension in root.iterdir():
            if not extension.is_dir():
                continue
            server = extension / "server"
            jar = _latest_jar(server, prefix)
            if jar:
                candidates.append(jar)
    return max(candidates, key=lambda path: _version_key(path.name), default=None)


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    if (cfg.get("app") or {}).get("mode", "browser") != "native":
        raise FixtureSkip("java_test_bundle requires the native packaged app")

    test_jar = _discover(JAVA_TEST_PREFIX, "QA_JAVA_TEST_BUNDLE")
    if not test_jar:
        raise FixtureSkip(
            "java-test extension is not installed; install the VS Code/Cursor "
            "Java test extension or set QA_JAVA_TEST_BUNDLE"
        )
    debug_jar = _discover(JAVA_DEBUG_PREFIX, "QA_JAVA_DEBUG_BUNDLE")
    values: dict[str, str] = getattr(ctx, "values")
    values["java_test_bundle_path"] = test_jar.parent.as_posix()
    values["java_debug_bundle_path"] = debug_jar.parent.as_posix() if debug_jar else ""

    case_dir = Path(getattr(ctx, "case_dir", Path("qa-ui-auto-report")))
    (case_dir / "java-test-bundle-receipt.json").write_text(
        json.dumps(
            {
                "javaTest": test_jar.as_posix(),
                "javaDebug": debug_jar.as_posix() if debug_jar else None,
                "home": Path.home().as_posix(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
