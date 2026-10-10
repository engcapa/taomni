"""Keep job-owned virtual input devices alive in the headless GNOME desktop."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import socket
import time


WINDOW_STATE = """(() => ({
    overview: Main.overview.visible || Main.overview.animationInProgress || Main.layoutManager.overviewGroup.visible,
    overview_visible: Main.overview.visible,
    overview_animating: Main.overview.animationInProgress,
    overview_actor_visible: Main.layoutManager.overviewGroup.visible,
    modal_count: Main.modalCount,
    stage_focus: global.stage.get_key_focus()?.get_accessible()?.get_name() ?? null,
    focused_application: imports.gi.Shell.WindowTracker.get_default().focus_app?.get_id() ?? null,
    starting_up: Main.layoutManager._startingUp,
    windows: global.get_window_actors().map(actor => {
        const window = actor.meta_window;
        return {pid: window.get_pid(), title: window.get_title(),
                wm_class: window.get_wm_class(),
                normal: window.get_window_type() === imports.gi.Meta.WindowType.NORMAL,
                focused: window.has_focus(), minimized: window.minimized,
                visible: actor.visible && !window.minimized, above: window.is_above(),
                actor: (() => { const [x, y] = actor.get_transformed_position();
                    const [width, height] = actor.get_transformed_size();
                    return {x, y, width, height}; })(),
                frame: (() => { const r = window.get_frame_rect();
                    return {x: r.x, y: r.y, width: r.width, height: r.height}; })(),
                client: (() => { const r = window.get_buffer_rect();
                    return {x: r.x, y: r.y, width: r.width, height: r.height}; })()};
    })
}))()"""


def owned_window_pid(windows, application: Path, runtime: Path, proc: Path = Path("/proc"), *, title=None) -> int:
    """Match a mapped window to the executable in this private compositor."""
    matches = []
    for window in windows:
        if title is not None and window["title"] != title:
            continue
        if title is None and not window.get("normal", True):
            # Tooltips/popups share the app's PID while the pointer dwells on
            # a grip. An unnamed main-window request must match its toplevel.
            continue
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
        if (after.get("overview_actor_visible") and not after.get("overview_visible")
                and not after.get("overview_animating")):
            # Shell can leave a reactive Overview actor after logical dismissal.
            # Complete its normal layout transition in this private desktop;
            # subsequent pointer input still has to move the app itself.
            evaluate("(() => { Main.layoutManager.hideOverview(); return true; })()")
        if time.monotonic() >= end:
            raise RuntimeError("GNOME did not focus the QA application window")
        time.sleep(0.05)


def move_pointer(evaluate, notify, x: int, y: int, *, absolute=False) -> list[int]:
    # Mutter queues virtual motion. Observe its resulting coordinates before
    # issuing a button event or computing the next relative displacement.
    for _ in range(20):
        current = evaluate("global.get_pointer().slice(0, 2)")
        if abs(x - current[0]) <= 1 and abs(y - current[1]) <= 1:
            return current
        notify(float(x if absolute else x - current[0]), float(y if absolute else y - current[1]))
        time.sleep(0.02)
    raise RuntimeError(f"Mutter pointer did not reach {(x, y)}; observed {current}")


def main() -> None:
    # Use the distro Python: Gio is installed with the GNOME desktop packages.
    from gi.repository import Gio, GLib

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ready", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--absolute-pointer", action="store_true",
                        help="inject logical absolute motion on the owned Clutter seat for mixed DPI")
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
        if args.absolute_pointer:
            # The job-owned Shell hosts a real virtual input device. Absolute
            # logical motion avoids relative-motion seams across output scales;
            # acceptance still requires Mutter's observed global pointer.
            def absolute_motion(px, py):
                evaluate("(() => { global.__taomniQaPointer.notify_absolute_motion("
                         f"imports.gi.GLib.get_monotonic_time(), {px}, {py}); return true; }})()")
            return move_pointer(evaluate, absolute_motion, x, y, absolute=True)
        return move_pointer(evaluate, lambda dx, dy: call(
            session, interface, "NotifyPointerMotionRelative", GLib.Variant("(dd)", (dx, dy))), x, y)

    def pointer_target():
        return evaluate("""(() => {
            const [x, y] = global.get_pointer();
            let actor = global.stage.get_actor_at_pos(imports.gi.Clutter.PickMode.REACTIVE, x, y);
            const path = [];
            while (actor && path.length < 16) {
                path.push({name: actor.get_name(), type: actor.constructor.name,
                    visible: actor.visible, mapped: actor.mapped,
                    pid: actor.meta_window?.get_pid() ?? null,
                    title: actor.meta_window?.get_title() ?? null});
                actor = actor.get_parent();
            }
            return path;
        })()""")

    def window_command(request, diagnostics):
        state = evaluate(WINDOW_STATE)
        diagnostics["observed"] = state
        title = request.get("title")
        pid = owned_window_pid(state["windows"], Path(request["application"]), args.socket.parent, title=title)
        window = next(w for w in state["windows"] if w["pid"] == pid and
                      (w.get("normal", True) if title is None else w["title"] == title))
        diagnostics["window"] = window
        if request["command"] == "geometry":
            return window
        if request["command"] == "place":
            rect = request["rect"]
            selector = f"w.get_pid() === {pid}" + (f" && w.get_title() === {json.dumps(title)}"
                if title is not None else " && w.get_window_type() === imports.gi.Meta.WindowType.NORMAL")
            evaluate(f"(() => {{ const w = global.get_window_actors().map(a => a.meta_window)"
                     f".find(w => {selector}); w.unmaximize(3); "
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
        if args.absolute_pointer:
            evaluate("(() => { global.__taomniQaPointer = global.backend.get_default_seat()"
                     ".create_virtual_device(imports.gi.Clutter.InputDeviceType.POINTER_DEVICE); return true; })()")
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
                    elif name == "text":
                        for character in request["text"]:
                            code = ord(character)
                            keysym = code if code <= 0xff else 0x01000000 | code
                            call(session, interface, "NotifyKeyboardKeysym", GLib.Variant("(ub)", (keysym, True)))
                            call(session, interface, "NotifyKeyboardKeysym", GLib.Variant("(ub)", (keysym, False)))
                            time.sleep(0.02)
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
                    elif name == "pointer_position":
                        value = evaluate("global.get_pointer().slice(0, 2)")
                    elif name == "shell_modal":
                        value = evaluate("Main.modalCount > 0")
                    elif name in {"button", "click"}:
                        if name == "click":
                            diagnostics["pointer"] = pointer(request["x"], request["y"])
                        button = {"left": 272, "right": 273, "middle": 274}[request["button"]]
                        call(session, interface, "NotifyPointerButton", GLib.Variant("(ib)", (button, True)))
                        time.sleep(0.05)
                        call(session, interface, "NotifyPointerButton", GLib.Variant("(ib)", (button, False)))
                    elif name == "wheel":
                        pointer(request["x"], request["y"])
                        call(session, interface, "NotifyPointerAxisDiscrete",
                             GLib.Variant("(ui)", (0, int(request["steps"]))))
                    elif name == "path":
                        points = request["points"]
                        if len(points) < 2:
                            raise ValueError("mouse path requires at least two points")
                        pointer(*points[0])
                        time.sleep(0.15)
                        call(session, interface, "NotifyPointerButton", GLib.Variant("(ib)", (272, True)))
                        try:
                            time.sleep(0.25)
                            for start, end in zip(points, points[1:]):
                                for step in range(1, 17):
                                    pointer(*(round(a + (b - a) * step / 16) for a, b in zip(start, end)))
                                    time.sleep(0.018)
                                time.sleep(0.12)
                        finally:
                            call(session, interface, "NotifyPointerButton", GLib.Variant("(ib)", (272, False)))
                    elif name == "drag":
                        start, end = request["start"], request["end"]
                        diagnostics["pointer_start"] = pointer(*start)
                        # Wait for Mutter's pointer enter/pick after queued
                        # motion, just as the multi-segment path injector does.
                        time.sleep(0.15)
                        diagnostics["after_pointer"] = evaluate(WINDOW_STATE)
                        activate_window(evaluate, Path(request["application"]), args.socket.parent, diagnostics)
                        diagnostics["target_start"] = pointer_target()
                        call(session, interface, "NotifyPointerButton", GLib.Variant("(ib)", (272, True)))
                        try:
                            time.sleep(0.2)
                            for step in range(1, 6):
                                pointer(*(round(a + (b - a) * step / 5) for a, b in zip(start, end)))
                                time.sleep(0.04)
                        finally:
                            call(session, interface, "NotifyPointerButton", GLib.Variant("(ib)", (272, False)))
                        diagnostics["pointer_end"] = evaluate("global.get_pointer().slice(0, 2)")
                        value = {"start": diagnostics["pointer_start"], "end": diagnostics["pointer_end"],
                                 "target": diagnostics["target_start"]}
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
        # A fresh headless pointer starts in GNOME's top-left hot corner.
        # WebDriver clicks don't move this OS pointer, so several read-only
        # RDP connects can reopen Overview before the first measured input.
        # Park it in the desktop interior before any app/target is launched.
        initial_pointer = pointer(*evaluate(
            "[Math.round(global.stage.width / 2), Math.round(global.stage.height / 2)]"))
        args.ready.write_text(json.dumps({"session": session, "devices": ["keyboard", "pointer"],
                                         "transport": "Mutter RemoteDesktop",
                                         "pointer_transport": "Clutter virtual absolute motion" if args.absolute_pointer
                                             else "Mutter RemoteDesktop relative motion",
                                         "initial_pointer": initial_pointer}), encoding="utf-8")
        # The session is tied to this DBus connection, so a one-shot gdbus
        # command would remove the devices immediately after provisioning.
        def quit_loop():
            loop.quit()
            return GLib.SOURCE_REMOVE

        for signum in (signal.SIGTERM, signal.SIGINT):
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signum, quit_loop)
        loop.run()
    finally:
        if args.absolute_pointer:
            evaluate("(() => { global.__taomniQaPointer = null; return true; })()")
        listener.close()
        args.socket.unlink(missing_ok=True)
        args.ready.unlink(missing_ok=True)
        call(session, interface, "Stop")


if __name__ == "__main__":
    main()
