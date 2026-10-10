"""Two OS-enumerated outputs and independent GTK pixel fixtures on owned CI desktops."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import sys

# org.gnome.Mutter.DisplayConfig: 1 = logical, 2 = physical.
MUTTER_LOGICAL_LAYOUT = 1


def monitor_configuration(state):
    """Use actual advertised modes/scales, never fabricate compositor metadata."""
    serial, monitors, _logical, _properties = state
    if len(monitors) != 2:
        raise RuntimeError(f"dual-display fixture needs two Mutter outputs, observed {len(monitors)}")
    configurations = []
    remaining = list(monitors)
    for index in range(2):
        dimensions = (1920, 1080) if index == 0 else (2560, 1440)
        scale = 1.0 if index == 0 else 2.0
        matched = next(((output, mode) for output in remaining for mode in output[1]
                        if (mode[1], mode[2]) == dimensions and scale in mode[5]), None)
        if matched is None:
            raise RuntimeError(f"outputs lack real mode {dimensions} with scale {scale}: {remaining}")
        output, mode = matched
        spec = output[0]
        remaining.remove(output)
        configurations.append((0 if index == 0 else 1920, 0, scale, 0, index == 0,
                               [(spec[0], mode[0], {})]))
    return serial, configurations


def configure(report):
    if os.environ.get("XDG_SESSION_TYPE") == "wayland":
        from gi.repository import Gio, GLib
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        def call(method, parameters=None):
            return bus.call_sync("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig",
                                 "org.gnome.Mutter.DisplayConfig", method, parameters, None,
                                 Gio.DBusCallFlags.NONE, 10000, None).unpack()
        serial, monitors = monitor_configuration(call("GetCurrentState"))
        call("ApplyMonitorsConfig", GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})",
             (serial, 1, monitors, {"layout-mode": GLib.Variant("u", MUTTER_LOGICAL_LAYOUT)})))
        observed = call("GetCurrentState")
        report.write_text(json.dumps({"transport": "Mutter DisplayConfig", "state": observed}, indent=2))
    else:
        # Xvfb accepts SetMonitor but cannot establish these outputs. The
        # Desktop owns an Xorg dummy server with independent RandR CRTCs.
        subprocess.run(["xrandr", "--addmode", "DUMMY1", "1920x1080"], check=True)
        subprocess.run(["xrandr", "--output", "DUMMY0", "--mode", "1920x1080", "--pos", "0x0", "--primary",
                        "--output", "DUMMY1", "--mode", "1920x1080", "--pos", "1920x0"], check=True)
        observed = subprocess.check_output(["xrandr", "--listmonitors"], text=True)
        report.write_text(json.dumps({"transport": "Xorg dummy RandR outputs", "state": observed,
                                     "outputs": subprocess.check_output(["xrandr", "--verbose"], text=True)}, indent=2))
    print(report.read_text(), flush=True)


def paint(context, width, height, index):
    # No fonts, video or network content. Whole-colour tile interiors give an
    # independent oracle for wrong monitor, crop offset and DPI scaling.
    palettes = [((0.72, 0.10, 0.18), (0.12, 0.20, 0.78)),
                ((0.08, 0.64, 0.24), (0.86, 0.56, 0.06))]
    for y in range(0, height, 64):
        for x in range(0, width, 64):
            context.set_source_rgb(*palettes[index][(x // 64 + y // 64) % 2])
            context.rectangle(x, y, min(64, width - x), min(64, height - y))
            context.fill()


def patterns(report):
    import cairo
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk, GLib
    display = Gdk.Display.get_default()
    if display.get_n_monitors() != 2:
        raise RuntimeError(f"GTK sees {display.get_n_monitors()} monitors, dual fixture is not ready")
    windows, facts = [], []
    for index in range(2):
        monitor = display.get_monitor(index)
        rect = monitor.get_geometry()
        scale = monitor.get_scale_factor()
        window = Gtk.Window(title=f"Taomni QA display pattern {index}")
        window.set_decorated(False)
        window.set_keep_above(True)
        window.set_default_size(rect.width, rect.height)
        area = Gtk.DrawingArea()
        area.connect("draw", lambda widget, context, i=index: paint(
            context, widget.get_allocated_width(), widget.get_allocated_height(), i))
        window.add(area)
        window.show_all()
        # Send the explicit output request after creating the native surface.
        window.fullscreen_on_monitor(display.get_default_screen(), index)
        windows.append(window)
        expected = report.parent / f"display-{index}-expected.png"
        surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, rect.width * scale, rect.height * scale)
        context = cairo.Context(surface)
        context.scale(scale, scale)
        paint(context, rect.width, rect.height, index)
        surface.write_to_png(str(expected))
        facts.append({"index": index, "name": monitor.get_model(), "logical": {
            "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height},
            "scale": scale, "expected": str(expected.resolve()), "primary": monitor == display.get_primary_monitor()})
    started, last = time.monotonic(), [None]
    def ready():
        observations = []
        for window, fact in zip(windows, facts):
            size = window.get_size()
            monitor = display.get_monitor_at_window(window.get_window()) if window.get_window() else None
            observed_index = next((i for i in range(2) if display.get_monitor(i) == monitor), None)
            observed = {"width": size[0], "height": size[1], "scale": window.get_scale_factor(),
                        "mapped": window.get_mapped(), "monitor": observed_index}
            if os.environ.get("XDG_SESSION_TYPE") == "wayland":
                from qa_ui_auto.wayland import command
                try:
                    observed["compositor"] = command("geometry", application=sys.executable,
                                                      title=window.get_title())["frame"]
                except RuntimeError as error:
                    observed["compositorError"] = str(error)
            fact["observedWindow"] = observed
            observations.append(observed)
        if observations != last[0]:
            print(json.dumps({"monitors": facts}), flush=True)
            last[0] = observations
            if os.environ.get("XDG_SESSION_TYPE") == "wayland":
                print(subprocess.check_output(["gdbus", "call", "--session", "--dest", "org.gnome.Mutter.DisplayConfig",
                    "--object-path", "/org/gnome/Mutter/DisplayConfig", "--method",
                    "org.gnome.Mutter.DisplayConfig.GetCurrentState"], text=True, timeout=5), flush=True)
        if any(not o["mapped"] or o["monitor"] != f["index"] or o["scale"] != f["scale"]
               or (o["width"], o["height"]) != (f["logical"]["width"], f["logical"]["height"])
               or (os.environ.get("XDG_SESSION_TYPE") == "wayland" and o.get("compositor") != f["logical"])
               for o, f in zip(observations, facts)):
            if time.monotonic() - started > 25:
                print("display pattern mapping timed out", flush=True)
                Gtk.main_quit()
                return False
            return True
        scales = {fact["scale"] for fact in facts}
        if os.environ.get("XDG_SESSION_TYPE") == "wayland" and scales != {1, 2}:
            raise RuntimeError(f"Wayland fixture did not establish 100%/200% scales: {facts}")
        report.write_text(json.dumps({"kind": "OS virtual outputs", "pid": os.getpid(), "monitors": facts,
                                      "mixedDpi": scales == {1, 2}}, indent=2))
        print("MULTI-DISPLAY-READY", flush=True)
        return False
    GLib.timeout_add(100, ready)
    Gtk.main()
    if not report.is_file():
        raise RuntimeError("OS display patterns did not map to their target geometry/scale")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["configure", "patterns"])
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    {"configure": configure, "patterns": patterns}[args.mode](args.report.resolve())


if __name__ == "__main__":
    main()
