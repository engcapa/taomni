"""Mixed ordinary documents beside sources, without altering shared fixtures."""
from pathlib import Path
from typing import Any

from . import workspace_explorer

FILES = {
    "Documents/preferences.json": '{"language":"auto","plainDocument":true}\n',
    "Documents/service.log": "2026-10-29 INFO ready\n2026-10-29 INFO ordinary log\n",
}


def setup(ctx: Any) -> None:
    workspace_explorer.setup(ctx)
    root = ctx.values["platform_workspace_root"]
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        for name, text in FILES.items():
            (Path(root) / name).write_bytes(text.encode("utf-8"))
    else:
        ctx.page.evaluate(
            """async ({root, files}) => {
              const vfs = await import('/src/stubs/localVfs.ts');
              for (const [name, text] of Object.entries(files)) await vfs.vfsWriteText(root + '/' + name, text);
            }""", {"root": root, "files": FILES},
        )
