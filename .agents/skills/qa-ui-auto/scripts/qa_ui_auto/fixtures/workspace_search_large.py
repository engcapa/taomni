"""Mixed files behind the explorer's 2,000-file cap; never touches personal HOME."""
from __future__ import annotations

from pathlib import Path
from typing import Any
from . import workspace_explorer


def setup(ctx: Any) -> None:
    workspace_explorer.setup(ctx)
    root = ctx.values["platform_workspace_root"]
    ctx.values["workspace_search_notes_text"] = workspace_explorer.FILES["Documents/notes.txt"]
    names = [f".00-index-noise/{index:04d}.txt" for index in range(2100)]
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        (Path(root) / ".00-index-noise").mkdir()
        (Path(root) / "EmptyDocuments").mkdir()
        for name in names:
            (Path(root) / name).write_text("noise\n", encoding="utf-8")
        return
    ctx.page.evaluate(
        """async ({root, names}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          await vfs.vfsMkdir(root + '/.00-index-noise');
          await vfs.vfsMkdir(root + '/EmptyDocuments');
          for (const name of names) await vfs.vfsWriteText(root + '/' + name, 'noise\\n');
        }""", {"root": root, "names": names})
