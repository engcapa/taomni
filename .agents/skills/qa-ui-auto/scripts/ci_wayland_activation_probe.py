"""Observe GTK restoration across the job-owned Wayland and XWayland displays."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time


def main():
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk, Gio, GLib, Gtk
    from qa_ui_auto.wayland import command

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    Gdk.set_allowed_backends("wayland,x11")
    Gtk.init([])
    native = Gtk.Window(title="QA activation native")
    native.add(Gtk.Entry())
    native.set_default_size(320, 240)
    native.show_all()
    x11 = Gdk.Display.open(os.environ["DISPLAY"])
    if x11 is None:
        raise RuntimeError("owned XWayland display unavailable")
    floating = Gtk.Window(title="QA activation floating")
    floating.set_screen(x11.get_default_screen())
    floating.add(Gtk.Entry())
    floating.set_default_size(240, 160)
    info = Gio.AppInfo.create_from_commandline(sys.executable, "QA activation", Gio.AppInfoCreateFlags.NONE)
    result = {"native_backend": native.get_display().__gtype__.name,
              "floating_backend": floating.get_display().__gtype__.name, "attempts": []}

    def settle():
        until = time.monotonic() + 0.4
        while time.monotonic() < until:
            while GLib.MainContext.default().pending():
                GLib.MainContext.default().iteration(False)
            time.sleep(0.01)

    def observe(window):
        settle()
        return command("geometry", application=sys.executable, title=window.get_title())

    def focus(window):
        window.show_all()
        settle()
        # This reset/input belongs only to the probe, never to product cases.
        command("place", application=sys.executable, title=window.get_title(),
                rect={"x": 400, "y": 200, "width": 320, "height": 240}, activate=True)
        state = observe(window)
        command("click", x=state["frame"]["x"] + 60,
                y=state["frame"]["y"] + 60, button="left")
        command("keys", chords=[[ord("a")]])
        settle()

    try:
        for method in ["present", "saved-wayland-token", "x11-launch-id", "remap"]:
            focus(native)
            token = native.get_display().get_app_launch_context().get_startup_notify_id(info, [])
            before = observe(native)
            native.iconify()
            minimized = observe(native)
            focus(floating)
            if method == "saved-wayland-token":
                native.set_startup_id(token)
            elif method == "x11-launch-id":
                native.set_startup_id(x11.get_app_launch_context().get_startup_notify_id(info, []))
            elif method == "remap":
                native.hide()
                settle()
            native.deiconify()
            native.show_all()
            native.present()
            after = observe(native)
            result["attempts"].append({"method": method, "before": before,
                                       "minimized": minimized, "after": after,
                                       "token_available": bool(token)})
    finally:
        floating.destroy()
        native.destroy()
        settle()
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
