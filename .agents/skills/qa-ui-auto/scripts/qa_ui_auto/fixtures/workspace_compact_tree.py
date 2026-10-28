"""A disposable Home-shaped tree for Compact directory lifecycle regressions.

AppData has many branching descendants and src has a compressible chain.
Neither native tests nor fixture cleanup touch the real user Home directory.
"""
from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Any

from . import platform_workspace_root


FILES = {
    "README.md": "# Compact Home fixture\n",
    "Documents/notes.txt": "Compact directory browsing stays responsive.\n",
    "src/main/java/com/example/App.java": "package com.example; class App {}\n",
    "src/main/java/com/example/Helper.java": "package com.example; class Helper {}\n",
    "AppData/settings.ini": "scope=home\n",
    "AppData/Local/settings.ini": "scope=local\n",
    **{
        f"AppData/Local/Package-{package:02d}/Cache-{cache}/entry.txt": "Background application data.\n"
        for package in range(24)
        for cache in range(8)
    },
}


def setup(ctx: Any) -> None:
    platform_workspace_root.setup(ctx)
    root = str(ctx.values["platform_workspace_root"]) + "/compact-home"
    ctx.values["platform_workspace_root"] = root
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        for name, contents in FILES.items():
            path = Path(root) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(contents.encode("utf-8"))
        return

    folders = {""}
    for name in FILES:
        folders.update(str(parent) for parent in PurePosixPath(name).parents if str(parent) != ".")
    ctx.page.evaluate(
        """async ({root, files, folders}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          for (const folder of folders) {
            const path = folder ? root + '/' + folder : root;
            try { await vfs.vfsStat(path); }
            catch { await vfs.vfsMkdir(path); }
          }
          for (const [name, contents] of Object.entries(files)) {
            await vfs.vfsWriteText(root + '/' + name, contents);
          }
        }""",
        {"root": root, "files": FILES, "folders": sorted(folders, key=lambda value: (value.count('/'), value))},
    )
