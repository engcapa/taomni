"""Run-owned GTK file-list selection owner; launched only by native QA steps.

ctypes uses GTK's actual multi-target selection API on X11 or Wayland. The
foreground child stays alive until the fixture/session kills it; no xclip fork
or text fallback and no user's clipboard/configuration is read or restored.
"""
from __future__ import annotations

import ctypes as c
import ctypes.util
import json
from pathlib import Path
import sys


def serve(paths: list[str], ready: Path) -> None:
    gtk = c.CDLL(ctypes.util.find_library("gtk-3") or "libgtk-3.so.0")
    gdk = c.CDLL(ctypes.util.find_library("gdk-3") or "libgdk-3.so.0")
    gtk.gtk_init_check.argtypes = [c.c_void_p, c.c_void_p]
    gtk.gtk_init_check.restype = c.c_int
    if not gtk.gtk_init_check(None, None):
        raise RuntimeError("GTK could not open the configured native display")
    gdk.gdk_atom_intern_static_string.argtypes = [c.c_char_p]
    gdk.gdk_atom_intern_static_string.restype = c.c_void_p
    gtk.gtk_clipboard_get.argtypes = [c.c_void_p]
    gtk.gtk_clipboard_get.restype = c.c_void_p
    gtk.gtk_selection_data_set.argtypes = [c.c_void_p, c.c_void_p, c.c_int, c.c_void_p, c.c_int]
    clipboard = gtk.gtk_clipboard_get(gdk.gdk_atom_intern_static_string(b"CLIPBOARD"))
    uris = [Path(path).as_uri() for path in paths]
    formats = [b"text/uri-list", b"x-special/gnome-copied-files"]
    payloads = [("\r\n".join(uris) + "\r\n").encode(), ("copy\n" + "\n".join(uris)).encode()]
    buffers = [c.create_string_buffer(data) for data in payloads]

    class Target(c.Structure):
        _fields_ = [("target", c.c_char_p), ("flags", c.c_uint), ("info", c.c_uint)]

    get_type = c.CFUNCTYPE(None, c.c_void_p, c.c_void_p, c.c_uint, c.c_void_p)
    clear_type = c.CFUNCTYPE(None, c.c_void_p, c.c_void_p)

    @get_type
    def supply(_clipboard, selection, index, _data):
        gtk.gtk_selection_data_set(selection, gdk.gdk_atom_intern_static_string(formats[index]),
                                   8, buffers[index], len(payloads[index]))

    @clear_type
    def clear(_clipboard, _data):
        gtk.gtk_main_quit()

    entries = (Target * 2)(*(Target(mime, 0, index) for index, mime in enumerate(formats)))
    gtk.gtk_clipboard_set_with_data.argtypes = [c.c_void_p, c.POINTER(Target), c.c_uint,
                                               get_type, clear_type, c.c_void_p]
    gtk.gtk_clipboard_set_with_data.restype = c.c_int
    if not gtk.gtk_clipboard_set_with_data(clipboard, entries, 2, supply, clear, None):
        raise RuntimeError("GTK refused file-list ownership")
    ready.write_text(json.dumps({"formats": [mime.decode() for mime in formats], "owner": "GTK"}))
    gtk.gtk_main()


if __name__ == "__main__":
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    serve(request["paths"], Path(sys.argv[2]))
