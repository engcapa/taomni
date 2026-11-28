"""Fresh names outside an OS index, shared by real disk and the browser VFS."""
from pathlib import Path
from uuid import uuid4

from . import platform_workspace_root
from .explorer_files import path_attribute_match


def setup(ctx) -> None:
    platform_workspace_root.setup(ctx)
    token = uuid4().hex[:10]
    root = ctx.values["platform_workspace_root"] + "/search-" + token
    directory = f"Archive-{token}"
    name = f"Quarterly-Report-{token}.txt"
    text = "Quarterly fixture document " + token
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        (Path(root) / directory).mkdir(parents=True)
        (Path(root) / directory / name).write_text(text, encoding="utf-8")
    else:
        ctx.page.evaluate("""async ([base, dir, file, text]) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          await vfs.vfsMkdir(base);
          await vfs.vfsMkdir(base + '/' + dir);
          await vfs.vfsWriteText(base + '/' + dir + '/' + file, text);
        }""", [root, directory, name, text])
    ctx.values.update({
        "global_root": root,
        "global_dir": directory,
        "global_file": name,
        "global_text": text,
        "global_file_match": path_attribute_match(f"{root}/{directory}/{name}"),
        "global_dir_match": path_attribute_match(f"{root}/{directory}"),
        "global_needle": "qtrpt" + token,
        "global_empty": "filedoesnotexist" + token,
    })
