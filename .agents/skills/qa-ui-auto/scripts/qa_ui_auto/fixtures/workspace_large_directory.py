"""Public documents in a wide directory; no personal contents or projects."""
from pathlib import Path
from typing import Any

from . import workspace_language_files


def public_files() -> dict[str, str]:
    return {
        **{f"document-{index:04}.txt": f"Public document {index}\n" for index in range(300)},
        **{f"folder-{index:04}/note.txt": "Public child\n" for index in range(100)},
        ".local/public.txt": "Visible ordinary file, not application data\n",
        ".config/public.txt": "Visible ordinary configuration\n",
    }


def populate(ctx: Any, root: str) -> None:
    files = public_files()
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        for name, text in files.items():
            path = Path(root) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(text.encode("utf-8"))
        return
    ctx.page.evaluate("""async ({root, files}) => {
      const vfs = await import('/src/stubs/localVfs.ts');
      for (const [name, text] of Object.entries(files)) {
        const slash = name.lastIndexOf('/');
        if (slash >= 0) {
          const dir = root + '/' + name.slice(0, slash);
          try { await vfs.vfsStat(dir); } catch { await vfs.vfsMkdir(dir); }
        }
        await vfs.vfsWriteText(root + '/' + name, text);
      }
    }""", {"root": root, "files": files})


def setup(ctx: Any) -> None:
    workspace_language_files.setup(ctx)
    populate(ctx, ctx.values["platform_workspace_root"])
