"""Keep job-owned virtual input devices alive in the headless GNOME desktop."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import socket
import time


WINDOW_STATE = """(() => ({
    overview: Main.overview.visible,
    starting_up: Main.layoutManager._startingUp,
    windows: global.get_window_actors().map(actor => {
        const window = actor.meta_window;
        return {pid: window.get_pid(), title: window.get_title(),
                focused: window.has_focus(), minimized: window.minimized,
                frame: window.get_frame_rect()};
    })
}))()"""


def owned_window_pid(windows, application: Path, runtime: Path, proc: Path = Path("/proc")) -> int:
    """Match a mapped window to the executable in this private compositor."""
    matches = []
    for window in windows:
        pid = int(window["pid"])
        directory = proc / str(pid)
        try:
            executable = (directory / "exe").resolve(strict=True)
            environment = (directory / "environ").read_bytes().split(b"\0")
        except OSError:
            continue
        if executable == application.resolve(strict=True) and (
                b"XDG_RUNTIME_DIR=" + str(runtime).encode()) in environment:
            matches.append(pid)
    if len(matches) != 1:
        raise RuntimeError(f"expected one QA application window in the owned desktop; found {len(matches)}")
    return matches[0]


def activate_window(evaluate, application: Path, runtime: Path, diagnostics: dict) -> None:
    # WebDriver can focus a page without activating its GTK Wayland toplevel.
    # GNOME's own window activation also leaves its startup Overview first.
    # Match /proc identity instead of selecting an arbitrary Alt+Tab target.
    before = evaluate(WINDOW_STATE)
    diagnostics["before"] = before
    pid = owned_window_pid(before["windows"], application, runtime)
    diagnostics["pid"] = pid
    evaluate(f"(() => {{ Main.overview.hide(); const window = global.get_window_actors()"
             f".map(actor => actor.meta_window).find(window => window.get_pid() === {pid}); "
             "if (!window) throw new Error('QA window disappeared'); "
             "Main.activateWindow(window); return true; })()")
    end = time.monotonic() + 5
    while True:
        after = evaluate(WINDOW_STATE)
        diagnostics["after"] = after
        if not after["overview"] and any(window["pid"] == pid and window["focused"]
                                          for window in after["windows"]):
            return
        if time.monotonic() >= end:
            raise RuntimeError("GNOME did not focus the QA application window")
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

    def evaluate(code):
        result = bus.call_sync("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell", "Eval",
                               GLib.Variant("(s)", (code,)), None, Gio.DBusCallFlags.NONE, 10000, None)
        success, value = result.unpack()
        if not success:
            raise RuntimeError(f"owned GNOME desktop evaluation failed: {value}")
        return json.loads(value)

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
                diagnostics = {"time": time.time()}
                try:
                    request = json.loads(connection.makefile("rb").readline(4096))
                    if request.get("command") != "activate":
                        raise ValueError("unknown Wayland input command")
                    activate_window(evaluate, Path(request["application"]), args.socket.parent, diagnostics)
                except Exception as error:
                    diagnostics["error"] = str(error)
                    connection.sendall(json.dumps({"error": str(error)}).encode() + b"\n")
                else:
                    connection.sendall(b'{"ok":true}\n')
                finally:
                    with (args.ready.parent / "window-activation.jsonl").open("a", encoding="utf-8") as log:
                        log.write(json.dumps(diagnostics) + "\n")
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
