"""An ordinary mixed-document folder, visible in VFS and on native disk."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from . import platform_workspace_root


FILES = {
    **platform_workspace_root.SEED_FILES,
    "Draft2.txt": "Second draft, deliberately larger than the tenth.\n",
    "Draft10.txt": "Tenth.\n",
    "Documents/notes.txt": "Weekly notes\nMeeting at 10:30\n",
    "Documents/budget.csv": "item,amount\nTravel,120\n",
    "Pictures/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="teal"/></svg>\n',
    "src/main/java/com/example/App.java": "package com.example; class App {}\n",
    "src/main/java/com/example/util/Helper.java": "package com.example.util; class Helper {}\n",
    "src/test/java/com/example/AppTest.java": "package com.example; class AppTest {}\n",
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
    root += "/explorer-fixture"
    ctx.values["platform_workspace_root"] = root
    ctx.page.evaluate(
        """async ({root, files}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          for (const folder of ['', 'Documents', 'Pictures', 'src', 'src/main', 'src/main/java', 'src/main/java/com', 'src/main/java/com/example', 'src/main/java/com/example/util', 'src/test', 'src/test/java', 'src/test/java/com', 'src/test/java/com/example']) {
            try { await vfs.vfsStat(root + '/' + folder); }
            catch { await vfs.vfsMkdir(root + '/' + folder); }
          }
          for (const [name, contents] of Object.entries(files)) {
            await vfs.vfsWriteText(root + '/' + name, contents);
          }
        }""",
        {"root": root, "files": FILES},
    )
