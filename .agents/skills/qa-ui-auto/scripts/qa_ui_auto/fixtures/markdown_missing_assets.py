"""Cross-mode Markdown with valid content and deterministic rendering failures."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

from . import platform_workspace_root


SOURCE = """# Mermaid README export fallback

This paragraph and the valid assets must survive every export.

![Available logo](assets/present.png)

![Missing header](./img/header.png)

## Valid diagram

```mermaid
flowchart LR
A[Source] --> B[Preview]
B --> C[Export]
```

## Invalid Mermaid

```mermaid
flowchart LR
A --> [
```

## Invalid draw.io

```drawio
<mxfile>not a valid diagram</mxfile>
```

Readable tail: export must complete with explicit placeholders.
"""


def setup(ctx):
    platform_workspace_root.setup(ctx)
    root = ctx.values["platform_workspace_root"]
    pixels = io.BytesIO()
    from PIL import Image
    Image.new("RGB", (96, 64), (42, 116, 190)).save(pixels, format="PNG")
    source = SOURCE.encode("utf-8")
    files = {
        "mermaid-readme.md": source,
        "assets/present.png": pixels.getvalue(),
    }
    native = ctx.cfg["app"]["mode"] == "native"
    if native:
        for name, data in files.items():
            path = Path(root) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        exports = Path(root) / "exports"
        exports.mkdir(exist_ok=True)
    else:
        ctx.page.evaluate("""async ({root, files}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          try { await vfs.vfsStat(root + '/assets'); } catch { await vfs.vfsMkdir(root + '/assets'); }
          for (const [name, bytes] of Object.entries(files)) {
            await vfs.vfsWriteBytes(root + '/' + name, new Uint8Array(bytes).buffer);
          }
        }""", {"root": root, "files": {name: list(data) for name, data in files.items()}})
    ctx.values.update(
        markdown_missing_root=root,
        markdown_missing_source=root + "/mermaid-readme.md",
        markdown_missing_exports=root + "/exports",
        markdown_missing_sha=hashlib.sha256(source).hexdigest(),
    )
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    (ctx.case_dir / "file-open-fixture.json").write_text(json.dumps({
        "schema": "qa.file-open-fixture.v1",
        "mode": "native" if native else "browser",
        "root": root,
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
        "boundary": "Browser reads VFS bytes; native reads isolated host bytes independently of the viewer.",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def teardown(ctx):
    platform_workspace_root.teardown(ctx)
