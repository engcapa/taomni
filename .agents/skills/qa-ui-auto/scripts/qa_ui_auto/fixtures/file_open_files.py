"""Small file-open fixtures: real native bytes or isolated browser VFS, never viewer state."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from . import platform_workspace_root, mail_server
from .explorer_files import PNG

TEXT = "File open original\nSecond line\n中文\n"
SAVED = "File open saved\nSecond line\n中文\n"
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><script>window.FILE_OPEN_SVG_UNSAFE=true</script><rect width="120" height="80" fill="#2563eb" onload="alert(1)"/><image href="https://example.invalid/tracker.png"/></svg>\n'
SVG_SAVED = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#16a34a"/></svg>\n'
MARKDOWN = "# File open Markdown\n\n**Rendered bold** and `inline code`.\n\n## Details\n\n![Original](assets/pixel.png)\n\n- [ ] First task\n"
HTML = '''<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/local.css"></head><body><h1>File open HTML</h1><div id="resource">Local resource</div><img id="pixel" src="assets/pixel.png"><a href="next.html">Next local page</a><a href="https://example.invalid/external">External browser</a><script>
window.addEventListener("load", function () {
  console.log("FILE_OPEN_SCRIPT_OK");
  console.log("FILE_OPEN_RESOURCES " + getComputedStyle(document.getElementById("resource")).color + " " + document.getElementById("pixel").naturalWidth);
  try { console.log("FILE_OPEN_PARENT_BAD " + parent.document.title); } catch (_) { console.log("FILE_OPEN_PARENT_BLOCKED"); }
  fetch("https://example.invalid/file-open-blocked").then(function () { console.error("FILE_OPEN_NETWORK_BAD"); }).catch(function () { console.log("FILE_OPEN_NETWORK_BLOCKED"); });
});
</script></body></html>'''
MAIL_TEXT = "Mail attachment read-only fixture.\nSave locally before editing.\n"


def workspace(root: str) -> str:
    return json.dumps({"version": 1, "activeWorkspaceId": "default-workspace", "createdNodes": [], "workspaces": [{
        "id": "default-workspace", "name": "File open workspace", "description": "", "isDefault": True,
        "rootFolders": [{"id": "file-open-root", "name": "file-open-files", "path": root, "addedAt": 1}],
        "pinnedSessionIds": [], "activeLeftToolWindow": "project", "bottomDock": {"open": False, "activeTool": "terminal", "heightPx": 220},
        "openTabs": [], "activeTabId": "",
    }]}, ensure_ascii=False)


def setup(ctx: Any) -> None:
    platform_workspace_root.setup(ctx)
    native = (ctx.cfg.get("app") or {}).get("mode") == "native"
    root = ctx.values["platform_workspace_root"] + "/file-open-" + uuid4().hex[:10]
    files = {
        "notes.txt": TEXT.encode(), "recovery.txt": b"Recovery disk original\n", "retry.txt": b"Retry original\n",
        "binary.txt": b"\x00\xff\x00binary", "unsafe.svg": SVG.encode(), "live.md": MARKDOWN.encode(),
        "report.html": HTML.encode(), "next.html": b"<!doctype html><h1>Next local page</h1>",
        "assets/local.css": b"#resource { color: rgb(12, 34, 56); }", "assets/pixel.png": PNG,
        "src/sample.ts": b"export const fileOpenSource = true;\n", "unsupported.bin": b"\x00\xff\x10",
    }
    if native:
        for relative, data in files.items():
            destination = Path(root) / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        (Path(root) / "large.txt").write_bytes(b"Large file read-only\n" * 300_000)
    else:
        ctx.page.evaluate("""async ({root, files}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          await vfs.vfsMkdir(root);
          for (const dir of ['assets', 'src']) await vfs.vfsMkdir(root + '/' + dir);
          for (const [relative, bytes] of Object.entries(files)) await vfs.vfsWriteBytes(root + '/' + relative, new Uint8Array(bytes).buffer);
          await vfs.vfsWriteText(root + '/large.txt', 'Large file read-only\\n'.repeat(300000));
        }""", {"root": root, "files": {name: list(data) for name, data in files.items()}})
    ctx.values.update({
        "file_open_root": root, "file_open_workspace": workspace(root),
        "file_open_saved_sha": hashlib.sha256(SAVED.encode()).hexdigest(),
        "file_open_original_sha": hashlib.sha256(TEXT.encode()).hexdigest(),
        "file_open_svg_original_sha": hashlib.sha256(SVG.encode()).hexdigest(),
        "file_open_svg_saved_sha": hashlib.sha256(SVG_SAVED.encode()).hexdigest(),
        "file_open_markdown_sha": hashlib.sha256(MARKDOWN.encode()).hexdigest(),
        "file_open_png_sha": hashlib.sha256(PNG).hexdigest(),
        "file_open_html_sha": hashlib.sha256(HTML.encode()).hexdigest(),
    })
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    (ctx.case_dir / "file-open-fixture.json").write_text(json.dumps({
        "schema": "qa.file-open-fixture.v1", "mode": "native" if native else "browser", "root": root,
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
        "boundary": "Browser VFS bytes only; native independent host bytes. All runtime evidence unrun until an actual case receipt.",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def setup_mail(ctx: Any) -> None:
    mail_server.setup(ctx)
    native = (ctx.cfg.get("app") or {}).get("mode") == "native"
    ctx.values["file_open_mail_subject"] = "Account-level AI policy"
    ctx.values["file_open_mail_text"] = MAIL_TEXT
    if not native:
        return
    from .. import mail_fake_server
    server = mail_fake_server.ACTIVE
    if server is None:
        raise RuntimeError("file_open_mail requires the local fake mail server")
    with server.state.lock:
        for folder in server.state.folders.values():
            folder.messages.clear()
        raw = ("From: QA <qa@example.com>\r\nTo: reader@example.com\r\nSubject: Account-level AI policy\r\n"
               "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=file-open\r\n\r\n"
               "--file-open\r\nContent-Type: text/plain\r\n\r\nRead-only attachment fixture\r\n"
               "--file-open\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Disposition: attachment; filename=policy.txt\r\n"
               "Content-Transfer-Encoding: base64\r\n\r\n").encode() + base64.b64encode(MAIL_TEXT.encode()) + b"\r\n--file-open--\r\n"
        server.state.append_raw("INBOX", raw, [])


def teardown(ctx: Any) -> None:
    platform_workspace_root.teardown(ctx)
