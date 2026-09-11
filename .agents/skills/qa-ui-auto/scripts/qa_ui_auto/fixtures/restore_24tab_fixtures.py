"""Deterministic 24-tab workspace-restore fixture for ED-AUDIT-013.

Provisions 24 small plain-text files (``file00.txt`` … ``file23.txt``) with
distinct one-line contents in a fresh host directory, so the packaged app
measures the real workspace-restore chain: layout-snapshot read ->
planWorkspaceRestore active/background split -> bounded-queue reads ->
editor render.

All files use the ``.txt`` extension on purpose: no language server session
attaches to plain text, so the recorded request/active-ready/all-ready
timestamps isolate restore I/O and rendering from LSP import traffic.

The consuming case seeds ``taomni.codeWorkspace.layout.v2.<instance>`` with
12 tabs per leaf (primary active ``file00.txt``, secondary active
``file12.txt``) and asserts per-file contents; the file bytes below are the
exact literals the case references — keep them in sync.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any

FILE_COUNT = 24


def file_text(index: int) -> str:
    return f"restore-seed-{index:02d}\n"


def _normalize_workspace_path(path: str) -> str:
    # Port of normalizeWorkspacePath in src/stores/appStore.ts: trim,
    # backslashes to slashes, strip trailing slashes.
    trimmed = path.strip()
    normalized = trimmed.replace("\\", "/")
    while len(normalized) > 1 and normalized.endswith("/"):
        normalized = normalized[:-1]
    return normalized or trimmed


def _hash_string(value: str) -> str:
    # Port of hashString in src/stores/appStore.ts: 32-bit Java-style hash,
    # abs, lowercase base36. charCodeAt equals ord() for the ASCII paths
    # produced here.
    digest = 0
    for char in value:
        digest = (digest * 31 + ord(char)) % 0x100000000
    if digest >= 0x80000000:
        digest -= 0x100000000
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    number = abs(digest)
    if number == 0:
        return "0"
    out = ""
    while number:
        number, remainder = divmod(number, 36)
        out = digits[remainder] + out
    return out


def restore_instance_id(root_path: str) -> str:
    # Port of recentWorkspaceIdFromParts in src/stores/appStore.ts for one
    # folder root and no loose files. MainLayout.openCodeWorkspaceInfo
    # derives the same id, so the layout snapshot seeded under this id is
    # the one the restore effect reads.
    identity = json.dumps(
        {
            "roots": [{"path": _normalize_workspace_path(root_path), "kind": "folder"}],
            "looseFiles": [],
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return f"workspace-{_hash_string(identity)}"


def setup(ctx: Any) -> None:
    from . import FixtureSkip  # lazy: avoid package-init circular import

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    if mode != "native":
        raise FixtureSkip(
            "restore_24tab_fixtures provisions host files for the packaged "
            "editor; browser-VFS preview cannot observe them"
        )
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    base = report_root / "native-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    case_id = str(getattr(ctx, "case_id", "case"))
    worker = int(getattr(ctx, "worker_id", 0))
    root = Path(tempfile.mkdtemp(prefix=f"{case_id}-restore-w{worker}-", dir=str(base)))

    values: dict[str, str] = getattr(ctx, "values")
    values["restore_root"] = root.as_posix()
    values["restore_instance_id"] = restore_instance_id(root.as_posix())
    values["restore_file_count"] = str(FILE_COUNT)
    for index in range(FILE_COUNT):
        name = f"file{index:02d}.txt"
        data = file_text(index).encode("utf-8")
        (root / name).write_bytes(data)
        if index in (0, 12, 23):
            values[f"restore_file{index:02d}_sha256"] = hashlib.sha256(data).hexdigest()
            values[f"restore_file{index:02d}_content"] = file_text(index).rstrip("\n")


def teardown(ctx: Any) -> None:
    # Same retention policy as workspace_root: trees live until report
    # rotation prunes qa-ui-auto-report/, preserving failure evidence.
    return None
