"""Matching directory trees in browser VFS or the isolated native filesystem.

The cases create/open File sessions through the UI. This fixture only seeds
directory and file data; it never installs a completion provider or changes
the production renderer. Native files are retained as evidence in report_root.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

WIDE_DIRECTORY = "wide-" + "W" * 60
OVERFLOW_RELATIVE = f"{WIDE_DIRECTORY}/{WIDE_DIRECTORY}"
DIRECTORIES = ["project-alpha", "project-beta", "only space", "only space/child", ".hidden", "中文目录",
               WIDE_DIRECTORY, OVERFLOW_RELATIVE]
FILES = {"project.txt": "A file must never be offered as a navigation directory.\n",
         "project-beta/beta-marker.txt": "beta directory\n",
         "only space/child/child-marker.txt": "nested directory\n",
         f"{WIDE_DIRECTORY}/parent-marker.txt": "overflow parent\n",
         f"{OVERFLOW_RELATIVE}/overflow-marker.txt": "overflow directory\n"}


def setup(ctx: Any) -> None:
    mode = (ctx.cfg.get("app") or {}).get("mode", "browser")
    if mode == "browser":
        root = "/preview/path-completion"
        ctx.page.goto(ctx.cfg["app"]["base_url"], wait_until="domcontentloaded")
        ctx.page.evaluate("""async ({root, directories, files}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          for (const directory of [root, ...directories.map(name => root + '/' + name)]) {
            try { await vfs.vfsStat(directory); }
            catch { await vfs.vfsMkdir(directory); }
          }
          for (const [name, text] of Object.entries(files)) await vfs.vfsWriteText(root + '/' + name, text);
        }""", {"root": root, "directories": DIRECTORIES, "files": FILES})
    elif mode == "native":
        base = Path(ctx.report_root).resolve() / "native-workspaces"
        base.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix="path-completion-", dir=base))
        for name in DIRECTORIES:
            (directory / name).mkdir(parents=True, exist_ok=True)
        for name, text in FILES.items():
            (directory / name).write_bytes(text.encode("utf-8"))
        root = directory.as_posix()
    else:
        raise RuntimeError(f"Unsupported path_completion mode: {mode}")
    ctx.values["path_completion_root"] = root
    ctx.values["path_overflow_relative"] = OVERFLOW_RELATIVE
    ctx.values["path_overflow_directory"] = WIDE_DIRECTORY
    ctx.values["path_overflow_root"] = f"{root}/{OVERFLOW_RELATIVE}"
    case_dir = Path(ctx.case_dir)
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "path-completion-fixture.json").write_text(
        json.dumps({"mode": mode, "root": root, "directories": DIRECTORIES, "files": FILES}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
