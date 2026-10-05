"""Keep job-owned virtual input devices alive in the headless GNOME desktop."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import socket
import time


def activate_window(call, session, interface, variant) -> None:
    # Switch via GNOME's real input path. A WebDriver window switch focuses
    # the WebView page but cannot activate its Wayland toplevel on GTK.
    for keycode, pressed in ((56, True), (15, True), (15, False), (56, False)):
        call(session, interface, "NotifyKeyboardKeycode", variant("(ub)", (keycode, pressed)))
        time.sleep(0.05)


def main() -> None:
    # Use the distro Python: Gio is installed with the GNOME desktop packages.
    from gi.repository import Gio, GLib

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ready", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    args = parser.parse_args()
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    destination = "org.gnome.Mutter.RemoteDesktop"
    interface = destination + ".Session"

    def call(path, iface, method, parameters=None):
        return bus.call_sync(destination, path, iface, method, parameters, None,
                             Gio.DBusCallFlags.NONE, 10000, None)

    session = call("/org/gnome/Mutter/RemoteDesktop", destination, "CreateSession").unpack()[0]
    loop = GLib.MainLoop()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        call(session, interface, "Start")
        # Mutter creates these devices lazily. A balanced modifier stroke and
        # zero pointer movement populate wl_seat before any QA app is opened.
        call(session, interface, "NotifyKeyboardKeycode", GLib.Variant("(ub)", (29, True)))
        call(session, interface, "NotifyKeyboardKeycode", GLib.Variant("(ub)", (29, False)))
        call(session, interface, "NotifyPointerMotionRelative", GLib.Variant("(dd)", (0.0, 0.0)))
        listener.bind(str(args.socket))
        args.socket.chmod(0o600)
        listener.listen(1)

        def command_ready(*_):
            connection, _address = listener.accept()
            with connection:
                connection.settimeout(10)
                try:
                    if connection.makefile("rb").readline(32) != b"activate\n":
                        raise ValueError("unknown Wayland input command")
                    activate_window(call, session, interface, GLib.Variant)
                except Exception as error:
                    connection.sendall(json.dumps({"error": str(error)}).encode() + b"\n")
                else:
                    connection.sendall(b'{"ok":true}\n')
            return GLib.SOURCE_CONTINUE

        GLib.io_add_watch(listener.fileno(), GLib.IO_IN, command_ready)
        args.ready.write_text(json.dumps({"session": session, "devices": ["keyboard", "pointer"],
                                         "transport": "Mutter RemoteDesktop"}), encoding="utf-8")
        # The session is tied to this DBus connection, so a one-shot gdbus
        # command would remove the devices immediately after provisioning.
        def quit_loop():
            loop.quit()
            return GLib.SOURCE_REMOVE

        for signum in (signal.SIGTERM, signal.SIGINT):
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signum, quit_loop)
        loop.run()
    finally:
        listener.close()
        args.socket.unlink(missing_ok=True)
        args.ready.unlink(missing_ok=True)
        call(session, interface, "Stop")


if __name__ == "__main__":
    main()
