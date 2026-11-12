"""Independent native file-list adapters; never call product clipboard IPC."""
from __future__ import annotations

import json
from pathlib import Path
import platform
import subprocess
from urllib.parse import unquote, urlsplit

from . import host_clipboard as host
from .deadline import budget_time as time
from .steps import StepError

MAC_SEED = host._JXA_PRELUDE + """
var paths = JSON.parse(arg);
var items = paths.map(function(path) {
  var item = $.NSPasteboardItem.alloc.init;
  var url = $.NSURL.fileURLWithPath($(path));
  if (!item.setStringForType(url.absoluteString, $('public.file-url'))) throw new Error('file URL rejected');
  return item;
});
pb.clearContents;
if (!pb.writeObjects($(items))) throw new Error('writeObjects rejected');
'ok';
"""
MAC_READ = host._JXA_PRELUDE + """
var urls = pb.readObjectsForClassesOptions($([$.NSURL]), $());
var paths = [];
if (!urls.isNil()) for (var i = 0; i < urls.count; i++) {
  var url = urls.objectAtIndex(i);
  if (!url.isFileURL) throw new Error('non-file URL');
  paths.push(url.path.js);
}
JSON.stringify({formats: ObjC.deepUnwrap(pb.types), paths: paths});
"""
WIN_READ = """
[Console]::OutputEncoding=[Text.Encoding]::UTF8;
$d=[System.Windows.Forms.Clipboard]::GetDataObject();
$paths=@([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string]$_ });
$formats=@(); if ($null -ne $d) { $formats=@($d.GetFormats()) };
[Console]::Out.Write((@{formats=$formats;paths=$paths} | ConvertTo-Json -Compress));
"""


def parse_uris(raw: str, *, gnome: bool = False) -> list[str]:
    lines = raw.splitlines()
    if gnome:
        if not lines or lines.pop(0) != "copy":
            raise StepError("file clipboard is not a copy list")
    paths = []
    for line in lines:
        if not line or line.startswith("#"):
            continue
        url = urlsplit(line)
        if url.scheme != "file" or url.query or url.fragment:
            raise StepError("file clipboard contains a non-file URI")
        path = unquote(url.path)
        if url.netloc and url.netloc != "localhost":
            path = "//" + url.netloc + path
        if not path.startswith("/"):
            raise StepError("file clipboard path is not absolute")
        paths.append(path)
    return paths


def stop(ctx) -> None:
    process = getattr(ctx, "_file_clipboard_process", None)
    if process is not None:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        ctx._file_clipboard_process = None


def seed(ctx, paths: list[str]) -> None:
    stop(ctx)
    system = platform.system()
    if system == "Windows":
        if not paths:
            host._ps("[System.Windows.Forms.Clipboard]::Clear()")
            return
        host._ps("$c=New-Object System.Collections.Specialized.StringCollection;"
                 "foreach($p in ($arg | ConvertFrom-Json)){[void]$c.Add($p)};"
                 "[System.Windows.Forms.Clipboard]::SetFileDropList($c)", json.dumps(paths))
    elif system == "Darwin":
        host._jxa(MAC_SEED if paths else host._JXA_PRELUDE + "pb.clearContents; 'ok'", json.dumps(paths))
    elif system == "Linux":
        request = ctx.case_dir / "file-clipboard-owner-input.json"
        ready = ctx.case_dir / "file-clipboard-owner-ready.json"
        request.write_text(json.dumps({"paths": paths}), encoding="utf-8")
        ready.unlink(missing_ok=True)
        with (ctx.case_dir / "file-clipboard-owner.log").open("ab") as log:
            process = subprocess.Popen(["/usr/bin/python3", "-I", str(Path(__file__).with_name("file_clipboard_owner.py")),
                                        str(request), str(ready)], stdout=log, stderr=log)
        ctx._file_clipboard_process = process
        if not getattr(ctx, "_file_clipboard_cleanup", False):
            original = ctx.restore_host_permissions
            def cleanup():
                try:
                    stop(ctx)
                finally:
                    original()
            ctx.restore_host_permissions = cleanup
            ctx._file_clipboard_cleanup = True
        deadline = time.monotonic() + 10
        while not ready.exists():
            if process.poll() is not None or time.monotonic() > deadline:
                stop(ctx)
                raise StepError("GTK file clipboard owner failed; see file-clipboard-owner.log")
            time.sleep(.05)
    else:
        raise StepError(f"unsupported native file clipboard platform: {system}")


def read(*, require_files: bool = True) -> dict:
    system = platform.system()
    if system == "Windows":
        result = json.loads(host._ps(WIN_READ))
        if require_files and "FileDrop" not in result["formats"]:
            raise StepError("native clipboard lacks Windows CF_HDROP/FileDrop")
        result["nativeFormat"] = "CF_HDROP" if "FileDrop" in result["formats"] else False
        return result
    if system == "Darwin":
        result = json.loads(host._jxa(MAC_READ))
        if require_files and not set(result["formats"]) & {"public.file-url", "NSFilenamesPboardType"}:
            raise StepError("native pasteboard lacks file URLs")
        result["nativeFormat"] = "NSURL/file-url" if result["paths"] else False
        return result
    formats = host.targets()
    wayland = host._wayland_text()
    def get(mime):
        return (host._run(["wl-paste", "--no-newline", "--type", mime]) if wayland
                else host._xclip_get(mime)).decode("utf-8", "strict")
    if not set(formats) & {"text/uri-list", "x-special/gnome-copied-files"}:
        if not require_files:
            return {"formats": formats, "paths": [], "nativeFormat": False}
        raise StepError("native clipboard lacks a Linux file-list MIME target")
    raw = {mime: get(mime) for mime in ("text/uri-list", "x-special/gnome-copied-files") if mime in formats}
    parsed = {mime: parse_uris(value, gnome=mime.startswith("x-special/")) for mime, value in raw.items()}
    if len(parsed) == 2 and parsed["text/uri-list"] != parsed["x-special/gnome-copied-files"]:
        raise StepError("native Linux file-list formats disagree")
    return {"formats": formats, "paths": next(iter(parsed.values())), "raw": raw,
            "nativeFormat": "Wayland file-list MIME" if wayland else "X11 file-list MIME"}
