"""Disposable Explorer files shared by browser VFS and real native disk.

Only filesystem/persisted inputs are seeded; UI actions call production handlers.
The byte oracle covers operations, while preview fixtures live outside that tree.
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from . import platform_workspace_root
from .workspace_drop_import import directories, snapshot, workspace_input

OP_FILES = {
    "source/alpha.txt": b"Alpha original must remain unchanged.\n",
    "source/beta.txt": b"Beta moves once without losing bytes.\n",
    "source/folder/nested/inner.txt": b"Recursive exact bytes.\n",
    "source/folder/nested/binary.bin": bytes(range(256)),
    "target/alpha.txt": b"Existing collision must never be overwritten.\n",
    "trash/delete-me.txt": b"Trash and restore exact original bytes.\n",
    "source/external.txt": b"Latest external system file clipboard.\n",
    "source/partial.txt": b"Partial batch success is preserved.\n",
    "target/folder/drag-source.txt": b"Drag source exact bytes.\n",
}
PREVIEW_TEXT = {
    "notes.txt": "Explorer preview text\nSecond line\n中文预览\n",
    "README.md": "# Explorer Markdown\n\n**Rendered bold** and `inline code`.\n\n- First item\n- Second item\n",
    "table.csv": 'name,value,note\nalpha,1,"quoted, comma"\nbeta,2,"line one\nline two"\n',
    "binary.txt": "header\x00binary payload",
    ".hidden.txt": "Hidden file is a real listed entry.\n",
}
# All chunks have valid CRCs; WebKitGTK rejects corrupt IDAT fixtures.
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=")
import struct
import zlib
_png = bytearray(PNG)
_offset = 8
while _offset < len(_png):
    _length = int.from_bytes(_png[_offset:_offset + 4], "big")
    _crc = zlib.crc32(_png[_offset + 4:_offset + 8 + _length])
    _png[_offset + 8 + _length:_offset + 12 + _length] = struct.pack(">I", _crc)
    _offset += 12 + _length
PNG = bytes(_png)
EMPTY_DIR = "source/folder/empty"


def operation_states() -> dict[str, Any]:
    files = dict(OP_FILES)
    extras = {EMPTY_DIR, "target", "trash", "target/folder/nested", "source/folder/nested"}
    states = {"seeded": snapshot(files, extras)}
    files["target/alpha - 副本.txt"] = files["source/alpha.txt"]
    states["copied"] = snapshot(files, extras)
    files["target/beta.txt"] = files.pop("source/beta.txt")
    states["moved"] = snapshot(files, extras)
    files["target/beta-renamed.txt"] = files.pop("target/beta.txt")
    states["renamed"] = snapshot(files, extras)
    deleted = files.pop("trash/delete-me.txt")
    states["trashed"] = snapshot(files, extras)
    files["trash/delete-me.txt"] = deleted
    states["restored"] = snapshot(files, extras)
    del files["trash/delete-me.txt"]
    states["permanent"] = snapshot(files, extras)
    files["target/external.txt"] = files["source/external.txt"]
    states["external"] = snapshot(files, extras)
    for name, data in list(files.items()):
        if name.startswith("source/folder/"):
            files["target/folder - 副本/" + name.removeprefix("source/folder/")] = data
    extras.add("target/folder - 副本/empty")
    states["recursive"] = snapshot(files, extras)
    files["target/folder/nested/drag-source.txt"] = files.pop("target/folder/drag-source.txt")
    states["drag-folder"] = snapshot(files, extras)
    files["target/folder/drag-source.txt"] = files["target/folder/nested/drag-source.txt"]
    states["drag-breadcrumb"] = snapshot(files, extras)
    files["source/folder/drag-source.txt"] = files.pop("target/folder/nested/drag-source.txt")
    states["drag-tree"] = snapshot(files, extras)
    files["target/partial.txt"] = files["source/partial.txt"]
    states["partial"] = snapshot(files, extras)
    return states


def path_attribute_match(path: str) -> str:
    """Match fixture paths in DOM without assuming Windows separator spelling.

    Entered paths retain '/', while native directory entries use '\\'. Both are
    the same fixture location; JSON string escaping also gives valid CSS strings.
    No basename-only selector can accidentally select another directory.
    """
    spellings = [path]
    if len(path) > 2 and path[1:3] == ":/":
        spellings.append(path.replace("/", "\\"))
    return ":is(" + ",".join("[data-path=" + json.dumps(value, ensure_ascii=False) + "]" for value in spellings) + ")"


def setup(ctx: Any) -> None:
    platform_workspace_root.setup(ctx)
    native = (ctx.cfg.get("app") or {}).get("mode") == "native"
    base = ctx.values["platform_workspace_root"] + "/workspace-drop-import-explorer-" + uuid4().hex[:10]
    operations = base + "/operations"
    preview = base + "/previews"
    files = {"operations/" + name: data for name, data in OP_FILES.items()}
    files.update({"previews/" + name: text.encode("utf-8") for name, text in PREVIEW_TEXT.items()})
    files["previews/logo.png"] = PNG
    files["previews/unknown.bin"] = b"\x00\xff\x10unknown binary"
    files["previews/folder/child.txt"] = b"Folder metadata child.\n"
    dirs = directories(files, {"operations/" + EMPTY_DIR, "previews/empty-folder", "operations/trash", "operations/target/folder/nested"})
    if native:
        for relative in dirs:
            (Path(base) / relative).mkdir(exist_ok=False)
        for relative, data in files.items():
            (Path(base) / relative).write_bytes(data)
        (Path(preview) / "large.txt").write_bytes(b"truncated line\n" * 20_000)
        with (Path(preview) / "huge.png").open("wb") as stream:
            stream.write(PNG)
            stream.truncate(20 * 1024 * 1024 + 1)
        external = Path(ctx.case_dir) / "external-file-manager-target"
        external.mkdir(exist_ok=False)
        ctx.values["explorer_external_target"] = external.as_posix()
    else:
        ctx.page.evaluate("""async ({base, files, directories}) => {
          localStorage.setItem('taomni.appTheme.v1', 'system');
          const vfs = await import('/src/stubs/localVfs.ts');
          for (const relative of directories) await vfs.vfsMkdir(relative ? base + '/' + relative : base);
          for (const [relative, bytes] of Object.entries(files)) await vfs.vfsWriteBytes(base + '/' + relative, new Uint8Array(bytes).buffer);
          await vfs.vfsWriteText(base + '/previews/large.txt', 'truncated line\\n'.repeat(20000));
          await vfs.vfsWriteBytes(base + '/previews/huge.png', new Uint8Array(20 * 1024 * 1024 + 1).buffer);
        }""", {"base": base, "directories": dirs, "files": {name: list(data) for name, data in files.items()}})
    ctx.values.update({
        "explorer_base": base, "explorer_operations": operations,
        "explorer_source": operations + "/source", "explorer_target": operations + "/target",
        "explorer_crumb_folder_match": path_attribute_match(operations + "/target/folder"),
        "explorer_source_match": path_attribute_match(operations + "/source"),
        "explorer_previews_match": path_attribute_match(preview),
        "explorer_source_folder_match": path_attribute_match(operations + "/source/folder"),
        "explorer_trash": operations + "/trash", "explorer_previews": preview,
        "explorer_workspace": workspace_input(base, preview),
        "explorer_alpha_sha": hashlib.sha256(OP_FILES["source/alpha.txt"]).hexdigest(),
        "explorer_collision_sha": hashlib.sha256(OP_FILES["target/alpha.txt"]).hexdigest(),
        "explorer_trash_sha": hashlib.sha256(OP_FILES["trash/delete-me.txt"]).hexdigest(),
        "explorer_external_sha": hashlib.sha256(OP_FILES["source/external.txt"]).hexdigest(),
    })
    manifest = {
        "schema": "qa.explorer-files.v1", "mode": "native" if native else "browser",
        "base": operations, "states": operation_states(),
        "evidenceBoundary": "Browser IndexedDB VFS only; native independent host SHA256 and real IPC. Physical OS drag/keys are separate.",
    }
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    (ctx.case_dir / "explorer-files-fixture.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def setup_large(ctx: Any) -> None:
    platform_workspace_root.setup(ctx)
    native = (ctx.cfg.get("app") or {}).get("mode") == "native"
    base = ctx.values["platform_workspace_root"] + "/explorer-large-" + uuid4().hex[:10]
    if native:
        Path(base).mkdir()
        for number in range(10_000):
            (Path(base) / f"entry-{number:05d}.txt").write_text(f"Entry {number}\n", encoding="utf-8")
    else:
        ctx.page.evaluate("""async (base) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          await vfs.vfsMkdir(base);
          for (let number = 0; number < 10000; number++) {
            await vfs.vfsWriteText(base + '/entry-' + String(number).padStart(5, '0') + '.txt', 'Entry ' + number + '\\n');
          }
        }""", base)
    ctx.values["explorer_large"] = base


def teardown(ctx: Any) -> None:
    # Keep native bytes + original manifest with the run; browser dies with context.
    platform_workspace_root.teardown(ctx)
