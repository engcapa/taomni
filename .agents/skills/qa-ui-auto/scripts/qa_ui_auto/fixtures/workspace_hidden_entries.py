"""Workspace tree fixture with directories normally excluded from recursion.

The regular Project tree must still expose these entries as a file explorer;
only recursive flat/package indexes skip them for bounded scans.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import platform_workspace_root


FILES = {
    "packages/node_modules/package.json": '{"name":"fixture-dependency"}\n',
    "packages/target/classes/App.class": "fixture-bytecode\n",
}


def setup(ctx: Any) -> None:
    platform_workspace_root.setup(ctx)
    root = str(ctx.values["platform_workspace_root"])
    mode = (ctx.cfg.get("app") or {}).get("mode")
    if mode == "native":
        root_path = Path(root)
        for name, contents in FILES.items():
            destination = root_path / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(contents, encoding="utf-8")
        return

    hidden_root = f"{root}/hidden-tree-fixture"
    ctx.values["platform_workspace_root"] = hidden_root
    ctx.page.evaluate(
        """async ({root, files}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          for (const folder of ['', 'packages', 'packages/node_modules', 'packages/target', 'packages/target/classes']) {
            try { await vfs.vfsStat(root + '/' + folder); }
            catch { await vfs.vfsMkdir(root + '/' + folder); }
          }
          for (const [name, text] of Object.entries(files)) {
            await vfs.vfsWriteText(root + '/' + name, text);
          }
        }""",
        {"root": hidden_root, "files": FILES},
    )

