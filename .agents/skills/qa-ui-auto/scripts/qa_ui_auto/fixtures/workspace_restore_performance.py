"""Create the fixed 24-tab workspace restore measurement fixture."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any


ROOT_ID = "ed013-root"
VALID_TAB_COUNT = 23
TOTAL_TAB_COUNT = 24
PRIMARY_COUNT = 12


def _file_key(path: str) -> str:
    return f"root:{ROOT_ID}:{path}"


def _recent_workspace_id(root_path: str) -> str:
    """Mirror recentWorkspaceIdFromParts for the generated native root."""
    normalized_path = root_path.strip().replace("\\", "/").rstrip("/") or root_path.strip()
    identity = json.dumps(
        {
            "roots": [{"path": normalized_path, "kind": "folder"}],
            "looseFiles": [],
        },
        separators=(",", ":"),
    )
    hash_value = 0
    for character in identity:
        hash_value = (hash_value * 31 + ord(character)) & 0xFFFFFFFF
    signed_hash = hash_value if hash_value < 0x80000000 else hash_value - 0x100000000
    return f"workspace-{_base36(abs(signed_hash))}"


def _base36(value: int) -> str:
    if value == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    result = ""
    while value:
        value, remainder = divmod(value, 36)
        result = digits[remainder] + result
    return result


def _snapshot(keys: list[str], active_key: str, other_keys: list[str], other_active_key: str) -> dict[str, Any]:
    return {
        "version": 2,
        "bottomDockOpen": False,
        "bottomDockTab": "references",
        "rightPaneOpen": False,
        "rightPaneTab": "outline",
        "languagePanelOpen": False,
        "splitOrientation": "vertical",
        "activeEditorGroupId": "primary",
        "expandedRootIds": [ROOT_ID],
        "expandedDirKeys": [],
        "layoutTreeV2": {
            "type": "split",
            "id": "ed013-split",
            "orientation": "vertical",
            "ratios": [0.5, 0.5],
            "children": [
                {"type": "leaf", "id": "primary", "openFileKeys": keys, "activeKey": active_key},
                {
                    "type": "leaf",
                    "id": "secondary",
                    "openFileKeys": other_keys,
                    "activeKey": other_active_key,
                },
            ],
        },
        "editorGroups": {
            "primary": {
                "openOrder": keys,
                "activeKey": active_key,
                "previewKey": None,
                "pinnedKeys": [],
            },
            "secondary": {
                "openOrder": other_keys,
                "activeKey": other_active_key,
                "previewKey": None,
                "pinnedKeys": [],
            },
        },
    }


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    if (cfg.get("app") or {}).get("mode", "browser") != "native":
        raise FixtureSkip("workspace_restore_performance requires the native host filesystem")

    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    case_id = str(getattr(ctx, "case_id", "case"))
    worker = int(getattr(ctx, "worker_id", 0))
    workspace_root = report_root / "native-workspaces"
    workspace_root.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix=f"{case_id}-w{worker}-restore-perf-", dir=str(workspace_root)))
    root.mkdir(parents=True, exist_ok=True)
    tabs_dir = root / "tabs"
    tabs_dir.mkdir()

    paths = [f"tabs/tab-{index:02d}.java" for index in range(1, VALID_TAB_COUNT + 1)]
    files: list[dict[str, Any]] = []
    for index, relative_path in enumerate(paths, start=1):
        payload = (
            "package restore;\n\n"
            f"public final class Tab{index:02d} {{\n"
            f"    public static final String marker = \"restore-tab-{index:02d}\";\n"
            "}\n"
        ).encode("utf-8")
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        files.append({
            "path": path.as_posix(),
            "relativePath": relative_path,
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })

    primary_paths = paths[:PRIMARY_COUNT]
    secondary_paths = paths[PRIMARY_COUNT:]
    failure_path = "tabs/read-failure.java"
    primary_keys = [_file_key(path) for path in primary_paths]
    secondary_keys = [_file_key(path) for path in secondary_paths] + [_file_key(failure_path)]
    active_path = primary_paths[0]
    secondary_active_path = secondary_paths[0]
    workspace_id = _recent_workspace_id(root.as_posix())
    values: dict[str, str] = getattr(ctx, "values")
    values.update({
        "workspace_restore_root": root.as_posix(),
        "workspace_restore_workspace_id": workspace_id,
        "workspace_restore_root_id": ROOT_ID,
        "workspace_restore_layout_key": f"taomni.codeWorkspace.layout.v2.{workspace_id}",
        "workspace_restore_layout_json": json.dumps(
            _snapshot(primary_keys, _file_key(active_path), secondary_keys, _file_key(secondary_active_path)),
            separators=(",", ":"),
        ),
        "workspace_restore_recent_json": json.dumps([{
            "id": workspace_id,
            "name": "ED013 restore performance",
            "roots": [{
                "id": ROOT_ID,
                "name": "ED013 restore performance",
                "path": root.as_posix(),
                "kind": "folder",
            }],
            "looseFiles": [],
            "lastOpenedAt": 1756100000000,
            "lastActiveFile": {"kind": "root", "rootId": ROOT_ID, "path": active_path},
            "isGitRepo": False,
        }], separators=(",", ":")),
        "workspace_restore_active_path": active_path,
        "workspace_restore_failure_path": failure_path,
        "workspace_restore_active_marker": "restore-tab-01",
    })
    (Path(getattr(ctx, "case_dir", report_root)) / "workspace-restore-fixture.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "fixtureId": "ED-AUDIT-013-restore-24-tabs-2-leaf",
            "workspaceId": workspace_id,
            "root": root.as_posix(),
            "rootId": ROOT_ID,
            "tabCount": TOTAL_TAB_COUNT,
            "validFileCount": VALID_TAB_COUNT,
            "primaryActive": active_path,
            "secondaryActive": secondary_active_path,
            "readFailurePath": failure_path,
            "files": files,
        }, indent=2) + "\n",
        encoding="utf-8",
    )
