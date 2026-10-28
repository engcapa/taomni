"""Mixed ordinary documents beside sources, without altering shared fixtures."""
from pathlib import Path
from typing import Any
import json

from . import workspace_explorer
from .workspace_json_documents import LONG_JSON_DOCUMENT

FILES = {
    "Documents/preferences.json": '{"language":"auto","plainDocument":true}\n',
    "Documents/service.log": "2026-10-29 INFO ready\n2026-10-29 INFO ordinary log\n",
}
JSON_DOCUMENT = json.dumps({"records": [
    {"id": index, "name": f"Public fixture {index:03}", "enabled": index % 2 == 0,
     "description": "Ordinary JSON document with no SDK or language server", "category": "sample"}
    for index in range(100)
]}, indent=2) + "\n"
assert len(JSON_DOCUMENT.splitlines()) == 704
FILES["Documents/records.json"] = JSON_DOCUMENT
FILES["Documents/long-records.json"] = LONG_JSON_DOCUMENT


def setup(ctx: Any) -> None:
    workspace_explorer.setup(ctx)
    root = ctx.values["platform_workspace_root"]
    ctx.values["workspace_json_text"] = JSON_DOCUMENT
    ctx.values["workspace_long_json_text"] = LONG_JSON_DOCUMENT
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
