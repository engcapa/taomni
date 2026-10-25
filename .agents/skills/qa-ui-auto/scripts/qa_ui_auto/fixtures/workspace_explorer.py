"""An ordinary mixed-document folder, visible in VFS and on native disk."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from . import platform_workspace_root


FILES = {
    "Documents/notes.txt": "Weekly notes\nMeeting at 10:30\n",
    "Documents/budget.csv": "item,amount\nTravel,120\n",
    "Pictures/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="teal"/></svg>\n',
}


def setup(ctx: Any) -> None:
    platform_workspace_root.setup(ctx)
    root = ctx.values["platform_workspace_root"]
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        for name, contents in FILES.items():
            path = Path(root) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(contents.encode("utf-8"))
        return
    ctx.page.evaluate(
        """async ({root, files}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          for (const folder of ['Documents', 'Pictures']) {
            try { await vfs.vfsStat(root + '/' + folder); }
            catch { await vfs.vfsMkdir(root + '/' + folder); }
          }
          for (const [name, contents] of Object.entries(files)) {
            await vfs.vfsWriteText(root + '/' + name, contents);
          }
        }""",
        {"root": root, "files": FILES},
    )
