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
import time
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
    # client takes ownership; the parent exits once the data is read. The
    # owner inherits stdout/stderr, so they must not be pipes this process
    # waits on (a pipe stays open until the owner exits): stderr goes to a
    # file instead.
    with tempfile.TemporaryFile() as err:
        result = subprocess.run(["xclip", "-selection", "clipboard", "-t", mime, "-i"],
                                input=data, timeout=10, stdout=subprocess.DEVNULL, stderr=err)
        if result.returncode:
            err.seek(0)
            raise RuntimeError(f"xclip failed ({result.returncode}): "
                               f"{err.read().decode('utf-8', 'replace')[-1500:]}")


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
        # CF_HTML is UTF-8. A .NET string would be stored in the ANSI code
        # page by Windows PowerShell's .NET Framework, so hand it the bytes.
        payload = json.dumps({"html": _cf_html(fragment), "text": plain})
        _ps("$p = $arg | ConvertFrom-Json; $d = New-Object System.Windows.Forms.DataObject;"
            "$bytes = [Text.Encoding]::UTF8.GetBytes($p.html + [char]0);"
            "$d.SetData('HTML Format', (New-Object System.IO.MemoryStream(,$bytes))); $d.SetText($p.text);"
            "[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)", payload)
    elif SYSTEM == "Darwin":
        payload = json.dumps({"html": fragment, "text": plain})
        _jxa(_JXA_PRELUDE + "var p = JSON.parse(arg); pb.clearContents;"
             "pb.setStringForType($(p.html), $.NSPasteboardTypeHTML);"
             "pb.setStringForType($(p.text), $.NSPasteboardTypeString); 'ok'", payload)
    else:
        # One xclip owner can only serve one target; HTML is the target under test.
        _xclip_set("text/html", fragment.encode("utf-8"))


_WIN32_CLIPBOARD = r"""
Add-Type -Namespace QaClip -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr owner);
[DllImport("user32.dll")] public static extern bool CloseClipboard();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint RegisterClipboardFormat(string name);
[DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint format);
[DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr handle);
[DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr handle);
[DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr handle);
'@
"""


def get_html() -> str:
    if SYSTEM == "Windows":
        # Read the CF_HTML bytes and decode them as UTF-8 ourselves: .NET
        # Framework decodes another application's "HTML Format" with the ANSI
        # code page, which garbles every non-ASCII character.
        raw = _ps(_WIN32_CLIPBOARD +
                  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
                  "$format = [QaClip.Native]::RegisterClipboardFormat('HTML Format');"
                  "$open = $false; for ($i = 0; $i -lt 40 -and -not $open; $i++) {"
                  " $open = [QaClip.Native]::OpenClipboard([IntPtr]::Zero);"
                  " if (-not $open) { Start-Sleep -Milliseconds 50 } };"
                  "if (-not $open) { throw 'clipboard is busy' };"
                  "try { $h = [QaClip.Native]::GetClipboardData($format);"
                  " if ($h -ne [IntPtr]::Zero) {"
                  "  $ptr = [QaClip.Native]::GlobalLock($h);"
                  "  $size = [int][QaClip.Native]::GlobalSize($h).ToUInt64();"
                  "  $bytes = New-Object byte[] $size;"
                  "  [Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, $size);"
                  "  [void][QaClip.Native]::GlobalUnlock($h);"
                  "  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes).TrimEnd([char]0)) } }"
                  " finally { [void][QaClip.Native]::CloseClipboard() }")
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


def _change_counter() -> int:
    """The clipboard's own change counter: the window station's sequence
    number on Windows, the general pasteboard's change count on macOS."""
    if SYSTEM == "Windows":
        return int(_ps("Add-Type -Namespace QaClip -Name Sequence -MemberDefinition "
                       "'[DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();';"
                       "[Console]::Out.Write([QaClip.Sequence]::GetClipboardSequenceNumber())"))
    return int(_jxa(_JXA_PRELUDE + "pb.changeCount.toString()"))


def _x11_owner_changes(seconds: float) -> int:
    """CLIPBOARD ownership changes reported by XFixes during ``seconds``.

    X11 has no change counter; every write makes its writer the selection
    owner, so counting SetSelectionOwner notifications counts writes."""
    import ctypes
    import ctypes.util

    xlib = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
    xfixes = ctypes.CDLL(ctypes.util.find_library("Xfixes") or "libXfixes.so.3")
    xlib.XOpenDisplay.restype = ctypes.c_void_p
    xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    xlib.XDefaultRootWindow.restype = ctypes.c_ulong
    xlib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    xlib.XInternAtom.restype = ctypes.c_ulong
    xlib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    xlib.XPending.argtypes = [ctypes.c_void_p]
    xlib.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    xlib.XFlush.argtypes = [ctypes.c_void_p]
    xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
    xfixes.XFixesQueryExtension.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int),
                                            ctypes.POINTER(ctypes.c_int)]
    xfixes.XFixesSelectSelectionInput.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
                                                  ctypes.c_ulong]
    display = xlib.XOpenDisplay(None)
    if not display:
        raise RuntimeError("cannot open the X display")
    try:
        event_base, error_base = ctypes.c_int(), ctypes.c_int()
        if not xfixes.XFixesQueryExtension(display, ctypes.byref(event_base), ctypes.byref(error_base)):
            raise RuntimeError("the X server has no XFixes extension")
        clipboard = xlib.XInternAtom(display, b"CLIPBOARD", 0)
        set_owner_notify_mask = 1
        xfixes.XFixesSelectSelectionInput(display, xlib.XDefaultRootWindow(display), clipboard,
                                          set_owner_notify_mask)
        xlib.XFlush(display)
        event = (ctypes.c_long * 24)()  # sizeof(XEvent)
        changes = 0
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            while xlib.XPending(display):
                xlib.XNextEvent(display, event)
                # XFixesSelectionNotify is the extension's first event.
                if ctypes.c_int.from_buffer(event).value == event_base.value:
                    changes += 1
            time.sleep(0.05)
        return changes
    finally:
        xlib.XCloseDisplay(display)


def count_changes(seconds: float) -> int:
    """How often the OS clipboard changes during the next ``seconds``."""
    if SYSTEM == "Linux":
        return _x11_owner_changes(seconds)
    before = _change_counter()
    time.sleep(seconds)
    return _change_counter() - before


def scratch_dir(base: Path) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="clip-", dir=str(base)))
