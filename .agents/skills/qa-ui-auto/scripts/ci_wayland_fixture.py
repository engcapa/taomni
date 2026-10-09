"""External GTK3 clipboard/image fixtures on the owned native Wayland desktop."""
from __future__ import annotations

import argparse
import ctypes
import os
from pathlib import Path


def main():
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk, GLib
    from qa_ui_auto.wayland import command

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["grant", "deny", "image"])
    parser.add_argument("--text", default="")
    parser.add_argument("--path", type=Path)
    args = parser.parse_args()
    window = Gtk.Window(title="Taomni QA MFA QR" if args.mode == "image" else "Taomni QA clipboard owner")
    window.set_keep_above(True)
    if args.mode == "image":
        window.add(Gtk.Image.new_from_file(str(args.path)))
    else:
        window.add(Gtk.Label(label="External Wayland clipboard fixture"))
    window.show_all()

    def publish():
        clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        library = ctypes.CDLL("libgtk-3.so.0")
        class Target(ctypes.Structure):
            _fields_ = [("target", ctypes.c_char_p), ("flags", ctypes.c_uint), ("info", ctypes.c_uint)]
        callback_type = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p)
        clear_type = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p)
        library.gtk_selection_data_get_target.argtypes = [ctypes.c_void_p]
        library.gtk_selection_data_get_target.restype = ctypes.c_void_p
        library.gtk_selection_data_set.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int,
                                                   ctypes.c_char_p, ctypes.c_int]
        payload = args.text.encode("utf-8") if args.mode == "grant" else b"\xff"
        @callback_type
        def send(_clipboard, selection, _info, _data):
            # An invalid UTF-8 offer produces a real text conversion error in
            # OS clients, rather than mutating the product's clipboard API.
            library.gtk_selection_data_set(selection, library.gtk_selection_data_get_target(selection),
                                           8, payload, len(payload))
        @clear_type
        def clear(_clipboard, _data):
            pass
        targets = (Target * 2)(Target(b"text/plain;charset=utf-8", 0, 0), Target(b"UTF8_STRING", 0, 1))
        library.gtk_clipboard_set_with_data.argtypes = [ctypes.c_void_p, ctypes.POINTER(Target), ctypes.c_uint,
                                                       callback_type, clear_type, ctypes.c_void_p]
        library.gtk_clipboard_set_with_data.restype = ctypes.c_int
        if not library.gtk_clipboard_set_with_data(hash(clipboard), targets, len(targets), send, clear, None):
            raise RuntimeError("GTK did not acquire the Wayland clipboard")
        # Keep ctypes callbacks alive for all compositor conversion requests.
        window._clipboard_callbacks = (send, clear, targets, clipboard)
        print("CLIPBOARD-READY", flush=True)
        return False

    def ready():
        command("focus_pid", pid=os.getpid())
        if args.mode == "image":
            width, height = window.get_size()
            print("WINDOW-READY", 0, 0, width, height, flush=True)
        else:
            command("keys", chords=[[0xFFE1]])
            GLib.timeout_add(200, publish)
        return False
    GLib.timeout_add(300, ready)
    Gtk.main()


if __name__ == "__main__":
    main()
