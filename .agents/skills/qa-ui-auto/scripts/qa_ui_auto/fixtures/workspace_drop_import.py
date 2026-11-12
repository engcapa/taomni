"""Two disposable roots and an external copy source, shared by browser/native.

Only seed filesystem bytes and persisted workspace input. No import command,
handler, fake DOM or product QA hook is installed. Trees/manifest stay retained.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

from . import platform_workspace_root

TEXT_FILES = {
    "root1/README.md": "Root one must remain untouched.\n",
    "root1/incoming/keep.txt": "Root one incoming sentinel.\n",
    "root2/README.md": "Root two is the explicit drop destination.\n",
    "root2/incoming/keep.txt": "Root two incoming sentinel.\n",
    "root2/incoming/collision.txt": "ORIGINAL target bytes must survive.\n",
    "source/中文 空格.txt": "中文与空格文件名\nExternal source stays unchanged.\n",
    "source/second file.txt": "Second independent dropped file.\n",
    "source/递归 目录/nested/inner.txt": "Nested recursive import.\nSecond line.\n",
    "source/collision.txt": "DIFFERENT external source must not replace target.\n",
    "source/recovery fresh.txt": "A fresh import succeeds after the collision.\n",
    "source/root file.txt": "Dropped onto root two, not its selected folder.\n",
    "source/ignored file.txt": "Dropping onto a file must do nothing.\n",
    "source/ignored blank.txt": "Dropping onto blank tree space must do nothing.\n",
}
FILES = {name: text.encode("utf-8") for name, text in TEXT_FILES.items()}
FILES["source/递归 目录/nested/binary.bin"] = bytes(range(256)) + b"\x00\xff\x00copy-not-move\x00"
EMPTY_DIR = "source/递归 目录/empty folder"

SEED_BROWSER = """async ({base, files, directories}) => {
  const vfs = await import('/src/stubs/localVfs.ts');
  for (const relative of directories) {
    await vfs.vfsMkdir(relative ? base + '/' + relative : base);
  }
  for (const [relative, bytes] of Object.entries(files)) {
    await vfs.vfsWriteBytes(base + '/' + relative, new Uint8Array(bytes).buffer);
  }
}"""


def directories(files: dict[str, bytes], extras: set[str]) -> list[str]:
    result = {"", *extras}
    for name in [*files, *extras]:
        result.update(str(parent) for parent in PurePosixPath(name).parents if str(parent) != ".")
    return sorted(result, key=lambda name: (name.count("/"), name))


def snapshot(files: dict[str, bytes], extras: set[str]) -> dict[str, Any]:
    return {"files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())},
            "directories": sorted(directories(files, extras))}


def expected_states() -> dict[str, Any]:
    files = dict(FILES)
    extras = {EMPTY_DIR}
    result = {"seeded": snapshot(files, extras)}
    for name, data in FILES.items():
        if name in {"source/中文 空格.txt", "source/second file.txt"} or name.startswith("source/递归 目录/"):
            files["root2/incoming/" + name.removeprefix("source/")] = data
    extras.add("root2/incoming/递归 目录/empty folder")
    result["directory"] = snapshot(files, extras)
    files["root2/incoming/recovery fresh.txt"] = FILES["source/recovery fresh.txt"]
    result["recovered"] = snapshot(files, extras)
    files["root2/root file.txt"] = FILES["source/root file.txt"]
    result["root"] = snapshot(files, extras)
    return result


def workspace_input(root1: str, root2: str) -> str:
    return json.dumps({
        "version": 1, "activeWorkspaceId": "default-workspace", "createdNodes": [],
        "workspaces": [{
            "id": "default-workspace", "name": "Default Workspace (默认工作区)",
            "description": "", "isDefault": True,
            "rootFolders": [
                {"id": "root1", "name": "drop-root-one", "path": root1, "addedAt": 1},
                {"id": "root2", "name": "drop-root-two", "path": root2, "addedAt": 2},
            ],
            "pinnedSessionIds": [], "activeLeftToolWindow": "project",
            "bottomDock": {"open": False, "activeTool": "terminal", "heightPx": 220},
            "openTabs": [], "activeTabId": "",
        }],
    }, ensure_ascii=False)


def setup(ctx: Any) -> None:
    platform_workspace_root.setup(ctx)
    native = (ctx.cfg.get("app") or {}).get("mode") == "native"
    # The ordinary native fixture owns the parent; browser contexts get a unique
    # subtree even if setup is repeated without reset_db during tool development.
    base = ctx.values["platform_workspace_root"] + "/workspace-drop-import-" + uuid4().hex[:12]
    dirs = directories(FILES, {EMPTY_DIR})
    if native:
        for relative in dirs:
            (Path(base) / relative).mkdir(exist_ok=False)
        for relative, data in FILES.items():
            (Path(base) / relative).write_bytes(data)
    else:
        ctx.page.evaluate(SEED_BROWSER, {
            "base": base, "files": {name: list(data) for name, data in FILES.items()}, "directories": dirs,
        })
    root1, root2, source = (base + "/" + name for name in ("root1", "root2", "source"))
    ctx.values.update({
        "workspace_drop_root1": root1, "workspace_drop_root2": root2,
        "workspace_drop_source": source,
        "workspace_drop_workspace": workspace_input(root1, root2),
    })
    for name in ("source/中文 空格.txt", "source/second file.txt", "source/递归 目录/nested/inner.txt",
                 "source/递归 目录/nested/binary.bin", "source/collision.txt", "source/recovery fresh.txt",
                 "source/root file.txt", "root2/incoming/collision.txt"):
        key = {"source/中文 空格.txt": "unicode", "source/second file.txt": "second",
               "source/递归 目录/nested/inner.txt": "nested", "source/递归 目录/nested/binary.bin": "binary",
               "source/collision.txt": "collision_source", "source/recovery fresh.txt": "recovery",
               "source/root file.txt": "root_file", "root2/incoming/collision.txt": "collision_target"}[name]
        ctx.values[f"workspace_drop_sha_{key}"] = hashlib.sha256(FILES[name]).hexdigest()
    case_dir = Path(ctx.case_dir)
    case_dir.mkdir(parents=True, exist_ok=True)
    manifest = case_dir / "workspace-drop-import-fixture.json"
    manifest.write_text(json.dumps({
        "schema": "qa.workspace-drop-import.v1", "mode": "native" if native else "browser",
        "base": base, "roots": {"root1": root1, "root2": root2}, "source": source,
        "states": expected_states(),
        "evidenceBoundary": "Synthetic event entry only; physical OS drag delivery is unverified.",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ctx.values["workspace_drop_manifest"] = manifest.as_posix()


def teardown(ctx: Any) -> None:
    # Retain real source/target bytes and the independent manifest as evidence;
    # browser VFS is destroyed with its isolated context, never copied to host.
    platform_workspace_root.teardown(ctx)
