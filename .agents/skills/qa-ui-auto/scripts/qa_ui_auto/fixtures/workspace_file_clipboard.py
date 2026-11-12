"""Extend drop-import's isolated bytes and hashes, without changing TC087/088."""
from __future__ import annotations

import json
from pathlib import Path

from . import workspace_drop_import as drop


def setup(ctx) -> None:
    drop.setup(ctx)
    manifest_path = Path(ctx.values["workspace_drop_manifest"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    # Keep clipboard target files/tree under the same source/root hash oracle.
    # External file-manager destinations are deliberately outside that tree.
    files = dict(drop.FILES)
    files["root1/cut-retained.txt"] = b"Internal cut keeps exact bytes.\n"
    files["source/latest B.txt"] = b"Latest system clipboard B, never stale A.\n"
    extras = {drop.EMPTY_DIR, "root2/cut-destination"}
    new_files = {key: value for key, value in files.items() if key not in drop.FILES}
    if manifest["mode"] == "native":
        base = Path(manifest["base"])
        (base / "root2/cut-destination").mkdir()
        for name, data in new_files.items():
            (base / name).write_bytes(data)
        external = ctx.case_dir / "system-paste-targets"
        external.mkdir()
        for kind in ("file", "directory"):
            (external / kind).mkdir()
        ctx.values["workspace_clipboard_external_file"] = (external / "file").as_posix()
        ctx.values["workspace_clipboard_external_directory"] = (external / "directory").as_posix()
    else:
        ctx.page.evaluate("""async ({base, files}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          await vfs.vfsMkdir(base + '/root2/cut-destination');
          for (const [name, bytes] of Object.entries(files)) await vfs.vfsWriteBytes(base + '/' + name, new Uint8Array(bytes).buffer);
          const clipboard = await import('/src/stubs/fileClipboard.ts');
          clipboard.clearFiles();
        }""", {"base": manifest["base"], "files": {name: list(data) for name, data in new_files.items()}})
    states = {"seeded": drop.snapshot(files, extras)}
    for name, data in drop.FILES.items():
        if name in {"source/中文 空格.txt", "source/second file.txt"} or name.startswith("source/递归 目录/"):
            files["root2/incoming/" + name.removeprefix("source/")] = data
    extras.add("root2/incoming/递归 目录/empty folder")
    states["directory"] = drop.snapshot(files, extras)
    files["root2/incoming/recovery fresh.txt"] = files["source/recovery fresh.txt"]
    states["recovered"] = drop.snapshot(files, extras)
    files["root2/latest B.txt"] = files["source/latest B.txt"]
    states["root"] = drop.snapshot(files, extras)
    files["root1/incoming/cut-retained.txt"] = files.pop("root1/cut-retained.txt")
    states["cut"] = drop.snapshot(files, extras)
    manifest["states"] = states
    manifest["evidenceBoundary"] = "Browser: VFS memory clipboard only. Native: actual OS file-list oracle and file-manager Paste, not product-read self-proof. UI unrun during tooling authoring."
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def teardown(ctx) -> None:
    drop.teardown(ctx)
