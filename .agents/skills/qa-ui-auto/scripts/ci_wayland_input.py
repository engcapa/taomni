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
    modal_count: Main.modalCount,
    stage_focus: global.stage.get_key_focus()?.get_accessible()?.get_name() ?? null,
    starting_up: Main.layoutManager._startingUp,
    windows: global.get_window_actors().map(actor => {
        const window = actor.meta_window;
        return {pid: window.get_pid(), title: window.get_title(),
                focused: window.has_focus(), minimized: window.minimized,
                visible: actor.visible && !window.minimized, above: window.is_above(),
                frame: (() => { const r = window.get_frame_rect();
                    return {x: r.x, y: r.y, width: r.width, height: r.height}; })(),
                client: (() => { const r = window.get_buffer_rect();
                    return {x: r.x, y: r.y, width: r.width, height: r.height}; })()};
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
    focus_window(evaluate, pid, diagnostics)


def focus_window(evaluate, pid: int, diagnostics: dict) -> dict:
    """Activate and observe the mapped toplevel, including Overview dismissal."""
    evaluate(f"(() => {{ Main.overview.hide(); const window = global.get_window_actors()"
             f".map(actor => actor.meta_window).find(window => window.get_pid() === {pid}); "
             "if (!window) throw new Error('QA window disappeared'); "
             "Main.activateWindow(window); return true; })()")
    end = time.monotonic() + 5
    while True:
        after = evaluate(WINDOW_STATE)
        diagnostics["after"] = after
        focused = next((window for window in after["windows"]
                        if window["pid"] == pid and window["focused"]), None)
        if not after["overview"] and focused:
            return focused
        if time.monotonic() >= end:
            raise RuntimeError("GNOME did not focus the QA application window")
        time.sleep(0.05)


def move_pointer(evaluate, notify, x: int, y: int) -> list[int]:
    # Mutter queues virtual motion. Observe its resulting coordinates before
    # issuing a button event or computing the next relative displacement.
    for _ in range(20):
        current = evaluate("global.get_pointer().slice(0, 2)")
        if abs(x - current[0]) <= 1 and abs(y - current[1]) <= 1:
            return current
        notify(float(x - current[0]), float(y - current[1]))
        time.sleep(0.02)
    raise RuntimeError(f"Mutter pointer did not reach {(x, y)}; observed {current}")


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

    def inject_keys(chords):
        for chord in chords:
            held = []
            try:
                for keysym in chord:
                    call(session, interface, "NotifyKeyboardKeysym", GLib.Variant("(ub)", (keysym, True)))
                    held.append(keysym)
                    time.sleep(0.04)
                time.sleep(0.08)
            finally:
                for keysym in reversed(held):
                    call(session, interface, "NotifyKeyboardKeysym", GLib.Variant("(ub)", (keysym, False)))
                    time.sleep(0.04)
            time.sleep(0.12)

    def pointer(x, y):
        return move_pointer(evaluate, lambda dx, dy: call(
            session, interface, "NotifyPointerMotionRelative", GLib.Variant("(dd)", (dx, dy))), x, y)

    def window_command(request, diagnostics):
        state = evaluate(WINDOW_STATE)
        pid = owned_window_pid(state["windows"], Path(request["application"]), args.socket.parent)
        window = next(w for w in state["windows"] if w["pid"] == pid)
        diagnostics["window"] = window
        if request["command"] == "geometry":
            return window
        if request["command"] == "place":
            rect = request["rect"]
            evaluate(f"(() => {{ const w = global.get_window_actors().map(a => a.meta_window)"
                     f".find(w => w.get_pid() === {pid}); w.unmaximize(3); "
                     f"w.move_resize_frame(true, {int(rect['x'])}, {int(rect['y'])}, "
                     f"{int(rect['width'])}, {int(rect['height'])}); return true; }})()")
            return True
        raise ValueError("unknown window command")

    session = call("/org/gnome/Mutter/RemoteDesktop", destination, "CreateSession").unpack()[0]
    loop = GLib.MainLoop()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    clipboard_serial = [0]
    try:
        call(session, interface, "Start")
        def clipboard_changed(*_):
            clipboard_serial[0] += 1
        bus.signal_subscribe(destination, interface, "SelectionOwnerChanged", session, None,
                             Gio.DBusSignalFlags.NONE, clipboard_changed)
        call(session, interface, "EnableClipboard", GLib.Variant("(a{sv})", ({},)))
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
                    name = request.get("command")
                    value = None
                    if name == "activate":
                        activate_window(evaluate, Path(request["application"]), args.socket.parent, diagnostics)
                    elif name == "focus_pid":
                        pid = int(request["pid"])
                        environment = (Path("/proc") / str(pid) / "environ").read_bytes().split(b"\0")
                        if b"XDG_RUNTIME_DIR=" + str(args.socket.parent).encode() not in environment:
                            raise RuntimeError("refusing a window outside the owned compositor")
                        value = focus_window(evaluate, pid, diagnostics)
                    elif name == "keys":
                        inject_keys(request["chords"])
                    elif name == "clipboard_serial":
                        value = clipboard_serial[0]
                    elif name == "xwayland_display":
                        value = evaluate("imports.gi.GLib.getenv('DISPLAY')")
                    elif name == "xwayland_authority":
                        value = evaluate("imports.gi.GLib.getenv('XAUTHORITY')")
                    elif name in {"geometry", "place"}:
                        value = window_command(request, diagnostics)
                    elif name == "pointer":
                        value = pointer(request["x"], request["y"])
                    elif name == "drag":
                        start, end = request["start"], request["end"]
                        diagnostics["pointer_start"] = pointer(*start)
                        call(session, interface, "NotifyPointerButton", GLib.Variant("(ib)", (272, True)))
                        try:
                            time.sleep(0.2)
                            for step in range(1, 6):
                                pointer(*(round(a + (b - a) * step / 5) for a, b in zip(start, end)))
                                time.sleep(0.04)
                        finally:
                            call(session, interface, "NotifyPointerButton", GLib.Variant("(ib)", (272, False)))
                        diagnostics["pointer_end"] = evaluate("global.get_pointer().slice(0, 2)")
                        value = {"start": diagnostics["pointer_start"], "end": diagnostics["pointer_end"]}
                    else:
                        raise ValueError("unknown Wayland input command")
                    diagnostics["command"] = name
                except Exception as error:
                    diagnostics["error"] = str(error)
                    connection.sendall(json.dumps({"error": str(error)}).encode() + b"\n")
                else:
                    connection.sendall(json.dumps({"ok": True, "value": value}).encode() + b"\n")
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
