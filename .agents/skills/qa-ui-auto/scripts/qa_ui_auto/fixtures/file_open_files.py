"""Small file-open fixtures: real native bytes or isolated browser VFS, never viewer state."""
from __future__ import annotations

import base64
import hashlib
import json
import io
import wave
import zipfile
from pathlib import Path
from typing import Any
from uuid import uuid4

from . import platform_workspace_root, mail_server
from .taoffice_7z import archive as seven_zip_fixture
from .taoffice_archive_extraction import archive as resumable_zip_fixture
from .taoffice_locked_pdf import document as locked_pdf_fixture
from .taoffice_pdf import document as pdf_fixture
from .taoffice_tar import archives as tar_fixtures, compressed_text
from .taoffice_workbook import fixtures as workbook_fixtures, legacy_fixtures
from .explorer_files import PNG

TEXT = "File open original\nSecond line\n中文\n"
SAVED = "File open saved\nSecond line\n中文\n"
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><script>window.FILE_OPEN_SVG_UNSAFE=true</script><rect width="120" height="80" fill="#2563eb" onload="alert(1)"/><image href="https://example.invalid/tracker.png"/></svg>\n'
SVG_SAVED = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#16a34a"/></svg>\n'
# Editable text just above the 512 KiB localStorage draft cap, so "keep draft"
# must fall back to the native Notepad snapshot / browser stub backup store.
DRAFT_LARGE = "".join(
    f"Draft recovery line {index:05d} - The quick brown fox jumps over the lazy dog.\n"
    for index in range(10_000)
)
MARKDOWN = "# File open Markdown\n\n**Rendered bold** and `inline code`.\n\nMath: $x^2$ and $$\\frac{1}{2}$$.\n\n## Details\n\n![Original](assets/pixel.png)\n\n- [ ] First task\n\n```mermaid\nflowchart LR\n  Explorer --> OpenFile --> Viewer\n```\n"
MARKDOWN_TABLE = "# Live table\n\n| **Heading** | Link | Safety |\n| :--- | :---: | ---: |\n| **bold** *italic* ~~removed~~ `code` $x^2$ | [safe](https://example.test) | [bad](javascript:alert(1)) <img src=\"assets/pixel.png\" onerror=\"window.TABLE_UNSAFE=true\"> |\n| Keep \\| pipe | <u>underline</u><br>next | untouched |\n"
HTML = '''<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/local.css"></head><body><h1>File open HTML</h1><div id="resource">Local resource</div><img id="pixel" src="assets/pixel.png"><a href="next.html">Next local page</a><a href="https://example.invalid/external">External browser</a><script>
window.addEventListener("load", function () {
  console.log("FILE_OPEN_SCRIPT_OK");
  console.log("FILE_OPEN_RESOURCES " + getComputedStyle(document.getElementById("resource")).color + " " + document.getElementById("pixel").naturalWidth);
  try { console.log("FILE_OPEN_PARENT_BAD " + parent.document.title); } catch (_) { console.log("FILE_OPEN_PARENT_BLOCKED"); }
  fetch("https://example.invalid/file-open-blocked").then(function () { console.error("FILE_OPEN_NETWORK_BAD"); }).catch(function () { console.log("FILE_OPEN_NETWORK_BLOCKED"); });
});
</script></body></html>'''
MAIL_TEXT = "Mail attachment read-only fixture.\nSave locally before editing.\n"
TAOFFICE_ASSETS = Path(__file__).resolve().parents[6] / "qa-ui-auto-tests/fixtures/taoffice"


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
        "draft-large.txt": DRAFT_LARGE.encode(),
        "binary.txt": b"\x00\xff\x00binary", "unsafe.svg": SVG.encode(), "live.md": MARKDOWN.encode(),
        "table.md": MARKDOWN_TABLE.encode(),
        "report.html": HTML.encode(), "next.html": b"<!doctype html><h1>Next local page</h1>",
        "assets/local.css": b"#resource { color: rgb(12, 34, 56); }", "assets/pixel.png": PNG,
        "src/sample.ts": b"export const fileOpenSource = true;\n", "unsupported.bin": b"\x00\xff\x10",
    }
    if ctx.case_id == "TC-TAOFFICE-002":
        files["records.tsv"] = 'City\tNote\r\nTokyo\t"Metro, East"\r\nParis\t"Line 1\nLine 2"\r\n'.encode()
    if ctx.case_id == "TC-TAOFFICE-004":
        # 4x3 LZW TIFF, every pixel RGB(29, 81, 144).
        files["swatch.tif"] = base64.b64decode(
            "SUkqABoAAACAB0opCBQSBwWEQeFQaGQlIQEKAAABAwABAAAABAAAAAEBAwABAAAAAwAAAAIBAwADAAAAmAAAAAMBAwAB"
            "AAAABQAAAAYBAwABAAAAAgAAABEBBAABAAAACAAAABUBAwABAAAAAwAAABYBAwABAAAAAwAAABcBBAABAAAAEgAAABwBAwABAAAAAQAAAAAAAAAIAAgACAA="
        )
    if ctx.case_id in {"TC-TAOFFICE-051", "TC-TAOFFICE-052"}:
        archive, large_sha = resumable_zip_fixture(TEXT.encode())
        files["transfer.zip"] = archive
        ctx.values["taoffice_extraction_archive_sha"] = hashlib.sha256(archive).hexdigest()
        ctx.values["taoffice_extraction_large_sha"] = large_sha
    if ctx.case_id == "TC-TAOFFICE-006":
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("notes/readme.txt", TEXT)
            bundle.writestr("images/pixel.png", PNG)
        files["bundle.zip"] = archive.getvalue()
        rejected = io.BytesIO()
        with zipfile.ZipFile(rejected, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("file.txt", "First entry is safe.")
            bundle.writestr("../notes.txt", "This entry must be rejected.")
        files["unsafe.zip"] = rejected.getvalue()
    if ctx.case_id == "TC-TAOFFICE-009":
        files.update(tar_fixtures(TEXT.encode(), PNG))
        ctx.values["taoffice_tar_sha"] = hashlib.sha256(files["quarterly.TAR.GZ"]).hexdigest()
    if ctx.case_id == "TC-TAOFFICE-010":
        files["notes-backup.txt.GZ"] = compressed_text(TEXT.encode())
        ctx.values["taoffice_gzip_sha"] = hashlib.sha256(files["notes-backup.txt.GZ"]).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-011", "TC-TAOFFICE-012"}:
        files["records.7Z"] = seven_zip_fixture()
        ctx.values["taoffice_7z_sha"] = hashlib.sha256(files["records.7Z"]).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-013", "TC-TAOFFICE-014"}:
        files["records.RAR"] = (TAOFFICE_ASSETS / "records.RAR").read_bytes()
        ctx.values["taoffice_rar_sha"] = hashlib.sha256(files["records.RAR"]).hexdigest()
        ctx.values["taoffice_rar_text_sha"] = hashlib.sha256((TEXT * 32).encode()).hexdigest()
        if native:
            for name in ("legacy.rar", "locked.rar"):
                files[name] = (TAOFFICE_ASSETS / name).read_bytes()
    if ctx.case_id in {"TC-TAOFFICE-003", "TC-TAOFFICE-005"}:
        wav = io.BytesIO()
        with wave.open(wav, "wb") as audio:
            audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            audio.writeframes(bytes(32000))
        files["sample.wav"] = wav.getvalue()
        files["damaged.wav"] = b"Invalid WAV fixture"
        ctx.values["taoffice_wav_sha"] = hashlib.sha256(files["sample.wav"]).hexdigest()
    if ctx.case_id == "TC-TAOFFICE-001":
        files["Build.mppx"] = b'<Project xmlns="http://schemas.microsoft.com/project"><Name>Build</Name></Project>'
        files["Review.mpp"] = (TAOFFICE_ASSETS / "linked-tasks.mpp").read_bytes()
    if ctx.case_id in {"TC-TAOFFICE-007", "TC-TAOFFICE-008", "TC-TAOFFICE-033", "TC-TAOFFICE-034"}:
        files["report.pdf"] = pdf_fixture()
        files["locked.pdf"] = locked_pdf_fixture()
        files["damaged.pdf"] = b"This is not a PDF."
        ctx.values["taoffice_pdf_sha"] = hashlib.sha256(files["report.pdf"]).hexdigest()
        ctx.values["taoffice_locked_pdf_sha"] = hashlib.sha256(files["locked.pdf"]).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-015", "TC-TAOFFICE-016", "TC-TAOFFICE-019", "TC-TAOFFICE-020"}:
        files.update(workbook_fixtures(TAOFFICE_ASSETS, ctx.values))
    if ctx.case_id in {"TC-TAOFFICE-035", "TC-TAOFFICE-036"}:
        files.update(workbook_fixtures(TAOFFICE_ASSETS, ctx.values, forecast=True))
    if ctx.case_id in {"TC-TAOFFICE-049", "TC-TAOFFICE-050"}:
        files.update(legacy_fixtures(TAOFFICE_ASSETS, ctx.values))
    if ctx.case_id in {"TC-TAOFFICE-017", "TC-TAOFFICE-018"}:
        files["order-form.pdf"] = (TAOFFICE_ASSETS / "order-form.pdf").read_bytes()
        ctx.values["taoffice_pdf_form_sha"] = hashlib.sha256(files["order-form.pdf"]).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-021", "TC-TAOFFICE-022"}:
        files["planning-notes.docx"] = (TAOFFICE_ASSETS / "planning-notes.docx").read_bytes()
        files["damaged.docx"] = b"This is not a Word document."
        ctx.values["taoffice_word_sha"] = hashlib.sha256(files["planning-notes.docx"]).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-023", "TC-TAOFFICE-024"}:
        schedule = (TAOFFICE_ASSETS / "rollout.mppx").read_bytes()
        files["rollout.xml" if native else "rollout.mppx"] = schedule
        ctx.values["taoffice_project_sha"] = hashlib.sha256(schedule).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-025", "TC-TAOFFICE-026"}:
        files["rollout-replay.webm"] = (TAOFFICE_ASSETS / "rollout-replay.webm").read_bytes()
        ctx.values["taoffice_video_sha"] = hashlib.sha256(files["rollout-replay.webm"]).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-027", "TC-TAOFFICE-028"}:
        plan = (TAOFFICE_ASSETS / "shift-plan.mppx").read_bytes()
        files["shift-plan.xml" if native else "shift-plan.mppx"] = plan
        ctx.values["taoffice_schedule_sha"] = hashlib.sha256(plan).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-037", "TC-TAOFFICE-038"}:
        plan = (TAOFFICE_ASSETS / "shift-work.mppx").read_bytes()
        files["shift-work.xml" if native else "shift-work.mppx"] = plan
        ctx.values["taoffice_schedule_sha"] = hashlib.sha256(plan).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-029", "TC-TAOFFICE-030"}:
        files["linked-tasks.mpp"] = (TAOFFICE_ASSETS / "linked-tasks.mpp").read_bytes()
        files["damaged.mpp"] = b"This is not a Project file."
        digest = hashlib.sha256(files["linked-tasks.mpp"]).hexdigest()
        ctx.values["taoffice_mpp_sha"] = digest
        if not native:
            ctx.values["taoffice_mpp_preview"] = json.dumps({
                "hash": digest, "xml": (TAOFFICE_ASSETS / "linked-tasks-preview.xml").read_text(encoding="utf-8"),
            })
    if ctx.case_id in {"TC-TAOFFICE-055", "TC-TAOFFICE-056"}:
        data = (TAOFFICE_ASSETS / "exchange-de.mpx").read_bytes()
        files["exchange-de.mpx"] = data
        files["damaged.mpx"] = b"MPX"
        ctx.values["taoffice_mpx_sha"] = hashlib.sha256(data).hexdigest()
        if not native:
            ctx.values["taoffice_mpx_preview"] = json.dumps({
                "hash": ctx.values["taoffice_mpx_sha"],
                "xml": (TAOFFICE_ASSETS / "exchange-preview.xml").read_text(encoding="utf-8"),
            })
    if ctx.case_id in {"TC-TAOFFICE-031", "TC-TAOFFICE-032"}:
        data = (TAOFFICE_ASSETS / "rollout-compatible.mkv").read_bytes()
        files["rollout-compatible.mkv"] = data
        ctx.values["taoffice_mkv_sha"] = hashlib.sha256(data).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-039", "TC-TAOFFICE-040"}:
        data = (TAOFFICE_ASSETS / "ppt-review.pptx").read_bytes()
        files["ppt-review.pptx"] = data
        files["ppt-damaged.pptx"] = b"This is not a PowerPoint package."
        ctx.values["taoffice_ppt_sha"] = hashlib.sha256(data).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-041", "TC-TAOFFICE-042"}:
        for name, key in (("visio-routing.vsdx", "modern"), ("visio-legacy.vsd", "legacy")):
            data = (TAOFFICE_ASSETS / name).read_bytes()
            files[name] = data
            ctx.values[f"taoffice_visio_{key}_sha"] = hashlib.sha256(data).hexdigest()
        files["visio-damaged.vsdx"] = b"This is not a Visio document."
    if ctx.case_id in {"TC-TAOFFICE-043", "TC-TAOFFICE-044", "TC-TAOFFICE-045", "TC-TAOFFICE-046"}:
        for name, key in (("media-legacy.avi", "legacy"), ("media-edit.webm", "edit"),
                          ("media-legacy.flv", "legacy_flv"), ("media-legacy.wmv", "legacy_wmv"), ("media-legacy.rm", "legacy_rm")):
            data = (TAOFFICE_ASSETS / name).read_bytes()
            files[name] = data
            ctx.values[f"taoffice_{key}_media_sha"] = hashlib.sha256(data).hexdigest()
    if ctx.case_id in {"TC-TAOFFICE-047", "TC-TAOFFICE-048"}:
        for name, key in (("heif-quadrants.heic", "heic"), ("image-sample.psd", "psd"),
                          ("image-sample.dng", "dng"), ("image-no-preview.dng", "no_preview")):
            data = (TAOFFICE_ASSETS / name).read_bytes()
            files[name] = data
            ctx.values[f"taoffice_image_{key}_sha"] = hashlib.sha256(data).hexdigest()
        files["image-damaged.heic"] = b"This is not a HEIC image."
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
        "file_open_draft_large_sha": hashlib.sha256(DRAFT_LARGE.encode()).hexdigest(),
        "file_open_original_sha": hashlib.sha256(TEXT.encode()).hexdigest(),
        "file_open_svg_original_sha": hashlib.sha256(SVG.encode()).hexdigest(),
        "file_open_svg_saved_sha": hashlib.sha256(SVG_SAVED.encode()).hexdigest(),
        "file_open_markdown_sha": hashlib.sha256(MARKDOWN.encode()).hexdigest(),
        "file_open_table_sha": hashlib.sha256(MARKDOWN_TABLE.encode()).hexdigest(),
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
    pop3_attachment = ctx.case_id in {"TC-MAIL-POP3-01", "TC-MODULES-076"}
    if pop3_attachment and native and ctx.case_id == "TC-MODULES-076":
        # Keep the original mailbox fixture while adding a stable MIME part.
        ctx.values["file_open_mail_target"] = (Path(ctx.case_dir).resolve() / "pop3-policy.txt").as_posix()
        ctx.values["file_open_mail_sha256"] = hashlib.sha256(MAIL_TEXT.encode()).hexdigest()
    if not native:
        return
    from .. import mail_fake_server
    server = mail_fake_server.ACTIVE
    if server is None:
        raise RuntimeError("file_open_mail requires the local fake mail server")
    signed_mail = ctx.case_id == "TC-MODULES-059"
    with server.state.lock:
        if not signed_mail and not pop3_attachment:
            for folder in server.state.folders.values():
                folder.messages.clear()
        raw = ("From: QA <qa@example.com>\r\nTo: reader@example.com\r\nSubject: Account-level AI policy\r\n"
               "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=file-open\r\n\r\n"
               "--file-open\r\nContent-Type: text/plain\r\n\r\nRead-only attachment fixture\r\n"
               "--file-open\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Disposition: attachment; filename=policy.txt\r\n"
               "Content-Transfer-Encoding: base64\r\n\r\n").encode() + base64.b64encode(MAIL_TEXT.encode()) + b"\r\n--file-open--\r\n"
        server.state.append_raw("Archive" if signed_mail else "INBOX", raw, [])


def teardown(ctx: Any) -> None:
    platform_workspace_root.teardown(ctx)
