"""Read/write the real OS clipboard with the platform's own tools.

This is the independent oracle for RDP clipboard redirection: the product
uses arboard, so these helpers deliberately use PowerShell/.NET (Windows),
AppKit through JXA (macOS) and xclip (Linux/X11) instead. Every function
raises RuntimeError with the tool's stderr on failure.
"""
from __future__ import annotations

import base64
import json
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

SYSTEM = platform.system()


def _run(argv: list[str], *, env: dict | None = None, timeout: float = 30.0,
         input_bytes: bytes | None = None) -> bytes:
    result = subprocess.run(argv, input=input_bytes, capture_output=True, timeout=timeout,
                            env={**os.environ, **(env or {})})
    if result.returncode:
        raise RuntimeError(f"{Path(argv[0]).name} failed ({result.returncode}): "
                           f"{result.stderr.decode('utf-8', 'replace')[-1500:]}")
    return result.stdout


# --------------------------------------------------------------- Windows

_PS_PRELUDE = (
    "$ErrorActionPreference='Stop';"
    "Add-Type -AssemblyName System.Windows.Forms;"
    "Add-Type -AssemblyName System.Drawing;"
    "$arg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:QA_CLIP_ARG));"
)


def _ps(script: str, arg: str = "") -> str:
    exe = shutil.which("powershell.exe") or "powershell.exe"
    encoded = base64.b64encode(arg.encode("utf-8")).decode("ascii")
    out = _run([exe, "-NoProfile", "-NonInteractive", "-STA", "-Command", _PS_PRELUDE + script],
               env={"QA_CLIP_ARG": encoded})
    return out.decode("utf-8", "replace").strip()


def _cf_html(fragment: str) -> str:
    prefix = "<html><body>\r\n<!--StartFragment-->"
    suffix = "<!--EndFragment-->\r\n</body></html>"
    header = ("Version:0.9\r\nStartHTML:{:010d}\r\nEndHTML:{:010d}\r\n"
              "StartFragment:{:010d}\r\nEndFragment:{:010d}\r\n")
    header_len = len(header.format(0, 0, 0, 0).encode("utf-8"))
    start_fragment = header_len + len(prefix.encode("utf-8"))
    end_fragment = start_fragment + len(fragment.encode("utf-8"))
    end_html = end_fragment + len(suffix.encode("utf-8"))
    return header.format(header_len, end_html, start_fragment, end_fragment) + prefix + fragment + suffix


# ----------------------------------------------------------------- macOS

def _jxa(script: str, arg: str = "") -> str:
    out = _run(["osascript", "-l", "JavaScript", "-e", script], env={"QA_CLIP_ARG": arg})
    return out.decode("utf-8", "replace").strip()


_JXA_PRELUDE = (
    "ObjC.import('AppKit');"
    "var arg = $.NSProcessInfo.processInfo.environment.objectForKey('QA_CLIP_ARG').js;"
    "var pb = $.NSPasteboard.generalPasteboard;"
)


# ----------------------------------------------------------------- Linux

def _xclip_set(mime: str, data: bytes) -> None:
    if not shutil.which("xclip"):
        raise RuntimeError("xclip is not installed")
    # xclip forks a background owner that serves the selection until another
    # client takes ownership; the parent exits once the data is read.
    subprocess.run(["xclip", "-selection", "clipboard", "-t", mime, "-i"], input=data,
                   check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _xclip_get(mime: str) -> bytes:
    if not shutil.which("xclip"):
        raise RuntimeError("xclip is not installed")
    return _run(["xclip", "-selection", "clipboard", "-t", mime, "-o"], timeout=10)


def targets() -> list[str]:
    if SYSTEM == "Linux":
        return _xclip_get("TARGETS").decode("utf-8", "replace").split()
    if SYSTEM == "Darwin":
        return _jxa(_JXA_PRELUDE + "ObjC.deepUnwrap(pb.types).join('\\n')").splitlines()
    return _ps("[System.Windows.Forms.Clipboard]::GetDataObject().GetFormats() -join \"`n\"").splitlines()


# --------------------------------------------------------------- public API

def set_text(text: str) -> None:
    if SYSTEM == "Windows":
        _ps("[System.Windows.Forms.Clipboard]::SetText($arg)", text)
    elif SYSTEM == "Darwin":
        _run(["pbcopy"], input_bytes=text.encode("utf-8"), env={"LANG": "en_US.UTF-8"})
    else:
        _xclip_set("UTF8_STRING", text.encode("utf-8"))


def get_text() -> str:
    if SYSTEM == "Windows":
        return _ps("[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
                   "[Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText())")
    if SYSTEM == "Darwin":
        return _run(["pbpaste"], env={"LANG": "en_US.UTF-8"}).decode("utf-8", "replace")
    return _xclip_get("UTF8_STRING").decode("utf-8", "replace")


def set_html(fragment: str, plain: str) -> None:
    if SYSTEM == "Windows":
        payload = json.dumps({"html": _cf_html(fragment), "text": plain})
        _ps("$p = $arg | ConvertFrom-Json; $d = New-Object System.Windows.Forms.DataObject;"
            "$d.SetData('HTML Format', $p.html); $d.SetText($p.text);"
            "[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)", payload)
    elif SYSTEM == "Darwin":
        payload = json.dumps({"html": fragment, "text": plain})
        _jxa(_JXA_PRELUDE + "var p = JSON.parse(arg); pb.clearContents;"
             "pb.setStringForType($(p.html), $.NSPasteboardTypeHTML);"
             "pb.setStringForType($(p.text), $.NSPasteboardTypeString); 'ok'", payload)
    else:
        # One xclip owner can only serve one target; HTML is the target under test.
        _xclip_set("text/html", fragment.encode("utf-8"))


def get_html() -> str:
    if SYSTEM == "Windows":
        raw = _ps("[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
                  "$d=[System.Windows.Forms.Clipboard]::GetData('HTML Format');"
                  "if ($d -is [System.IO.Stream]) { $r = New-Object System.IO.StreamReader($d); $d = $r.ReadToEnd() };"
                  "[Console]::Out.Write($d)")
        start = raw.find("<!--StartFragment-->")
        end = raw.find("<!--EndFragment-->")
        return raw[start + len("<!--StartFragment-->"):end] if start >= 0 and end > start else raw
    if SYSTEM == "Darwin":
        return _jxa(_JXA_PRELUDE + "var s = pb.stringForType($.NSPasteboardTypeHTML); s.isNil() ? '' : s.js")
    return _xclip_get("text/html").decode("utf-8", "replace")


def set_image(png: Path) -> None:
    png = Path(png).resolve()
    if SYSTEM == "Windows":
        _ps("$img=[System.Drawing.Image]::FromFile($arg);"
            "[System.Windows.Forms.Clipboard]::SetImage($img)", str(png))
    elif SYSTEM == "Darwin":
        _jxa(_JXA_PRELUDE + "var img = $.NSImage.alloc.initWithContentsOfFile($(arg));"
             "pb.clearContents; pb.writeObjects($([img])) ? 'ok' : (function(){throw new Error('writeObjects failed')})()",
             str(png))
    else:
        _xclip_set("image/png", png.read_bytes())


def save_image(out_png: Path) -> None:
    out_png = Path(out_png).resolve()
    out_png.parent.mkdir(parents=True, exist_ok=True)
    if SYSTEM == "Windows":
        _ps("$img=[System.Windows.Forms.Clipboard]::GetImage();"
            "if ($img -eq $null) { throw 'clipboard has no image' };"
            "$img.Save($arg, [System.Drawing.Imaging.ImageFormat]::Png)", str(out_png))
    elif SYSTEM == "Darwin":
        _jxa(_JXA_PRELUDE + "var d = pb.dataForType($.NSPasteboardTypePNG);"
             "if (d.isNil()) { var t = pb.dataForType($.NSPasteboardTypeTIFF);"
             " if (t.isNil()) throw new Error('clipboard has no image');"
             " var rep = $.NSBitmapImageRep.imageRepWithData(t);"
             " d = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()); }"
             "d.writeToFileAtomically($(arg), true) ? 'ok' : (function(){throw new Error('write failed')})()",
             str(out_png))
    else:
        out_png.write_bytes(_xclip_get("image/png"))


def set_files(paths: list[Path]) -> None:
    resolved = [str(Path(p).resolve()) for p in paths]
    if SYSTEM == "Windows":
        _ps("$c = New-Object System.Collections.Specialized.StringCollection;"
            "foreach ($p in ($arg | ConvertFrom-Json)) { [void]$c.Add($p) };"
            "[System.Windows.Forms.Clipboard]::SetFileDropList($c)", json.dumps(resolved))
    elif SYSTEM == "Darwin":
        _jxa(_JXA_PRELUDE + "var urls = JSON.parse(arg).map(function(p){ return $.NSURL.fileURLWithPath($(p)); });"
             "pb.clearContents; pb.writeObjects($(urls)) ? 'ok' : (function(){throw new Error('writeObjects failed')})()",
             json.dumps(resolved))
    else:
        uris = "".join(Path(p).as_uri() + "\r\n" for p in resolved)
        _xclip_set("text/uri-list", uris.encode("utf-8"))


def get_files() -> list[str]:
    if SYSTEM == "Windows":
        out = _ps("[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
                  "[Console]::Out.Write(([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }) -join \"`n\")")
        return [line for line in out.splitlines() if line.strip()]
    if SYSTEM == "Darwin":
        out = _jxa(_JXA_PRELUDE + "var items = pb.readObjectsForClassesOptions($([$.NSURL]), $());"
                   "var out = [];"
                   "if (!items.isNil()) { for (var i = 0; i < items.count; i++) {"
                   " out.push(items.objectAtIndex(i).path.js); } }"
                   "out.join('\\n')")
        return [line for line in out.splitlines() if line.strip()]
    from urllib.parse import unquote, urlparse

    raw = _xclip_get("text/uri-list").decode("utf-8", "replace")
    return [unquote(urlparse(line.strip()).path) for line in raw.splitlines()
            if line.strip() and not line.startswith("#")]


def clear() -> None:
    if SYSTEM == "Windows":
        _ps("[System.Windows.Forms.Clipboard]::Clear()")
    elif SYSTEM == "Darwin":
        _jxa(_JXA_PRELUDE + "pb.clearContents; 'ok'")
    else:
        _xclip_set("UTF8_STRING", b"")


def scratch_dir(base: Path) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="clip-", dir=str(base)))
