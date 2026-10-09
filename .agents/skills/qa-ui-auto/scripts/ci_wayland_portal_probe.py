"""Exercise real screenshot and RemoteDesktop consent before compiling the app."""
from __future__ import annotations

import json
from pathlib import Path
import struct
import time
from urllib.parse import unquote, urlparse
import uuid


def verify_portals(report: Path, *, remote_desktop: bool) -> dict:
    from gi.repository import Gio, GLib

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    destination = "org.freedesktop.portal.Desktop"
    object_path = "/org/freedesktop/portal/desktop"
    observations = []
    session = None

    def request(interface, method, signature, parameters):
        loop = GLib.MainLoop()
        received = {}

        def response(_bus, _sender, path, _interface, _signal, arguments):
            received.update(path=path, response=arguments.unpack())
            loop.quit()

        subscription = bus.signal_subscribe(destination, "org.freedesktop.portal.Request", "Response",
                                            None, None, Gio.DBusSignalFlags.NONE, response)
        timer = GLib.timeout_add_seconds(60, lambda: (loop.quit(), GLib.SOURCE_REMOVE)[1])
        try:
            started = time.monotonic()
            path = bus.call_sync(destination, object_path, "org.freedesktop.portal." + interface,
                                 method, GLib.Variant(signature, parameters), None,
                                 Gio.DBusCallFlags.NONE, 10000, None).unpack()[0]
            if not received:
                loop.run()
            observation = {"interface": interface, "method": method, "request": path,
                           "duration_sec": time.monotonic() - started, **received}
            observations.append(observation)
            (report / "portal-preflight.json").write_text(json.dumps(observations, indent=2))
            if received.get("path") != path or received.get("response", [None])[0] != 0:
                raise RuntimeError(f"real {interface}.{method} consent failed: {observation}")
            return received["response"][1]
        finally:
            bus.signal_unsubscribe(subscription)
            if GLib.MainContext.default().find_source_by_id(timer):
                GLib.source_remove(timer)

    def options(**values):
        return {"handle_token": GLib.Variant("s", "qa_" + uuid.uuid4().hex), **values}

    try:
        screenshot = request("Screenshot", "Screenshot", "(sa{sv})", ("", options(
            interactive=GLib.Variant("b", False), modal=GLib.Variant("b", True))))
        uri = urlparse(screenshot["uri"])
        if uri.scheme != "file":
            raise RuntimeError(f"screenshot portal returned a non-file URI: {uri.scheme}")
        path = Path(unquote(uri.path))
        contents = path.read_bytes()
        if contents[:8] != b"\x89PNG\r\n\x1a\n" or contents[12:16] != b"IHDR":
            raise RuntimeError("screenshot portal did not produce a PNG")
        width, height = struct.unpack(">II", contents[16:24])
        if min(width, height) <= 0:
            raise RuntimeError("screenshot portal returned an empty display")
        facts = {"screenshot": {"size": [width, height], "bytes": len(contents)}}
        if remote_desktop:
            session = request("RemoteDesktop", "CreateSession", "(a{sv})", (options(
                session_handle_token=GLib.Variant("s", "qa_session_" + uuid.uuid4().hex)),))["session_handle"]
            request("RemoteDesktop", "SelectDevices", "(oa{sv})", (session, options(
                types=GLib.Variant("u", 3))))
            request("ScreenCast", "SelectSources", "(oa{sv})", (session, options(
                types=GLib.Variant("u", 1), multiple=GLib.Variant("b", False))))
            started = request("RemoteDesktop", "Start", "(osa{sv})", (session, "", options()))
            if not started.get("streams") or started.get("devices", 0) & 3 != 3:
                raise RuntimeError(f"portal did not grant monitor, keyboard and pointer: {started}")
            facts["remote_desktop"] = {"streams": started["streams"], "devices": started["devices"]}
        return facts
    finally:
        if session:
            bus.call_sync(destination, session, "org.freedesktop.portal.Session", "Close", None,
                          None, Gio.DBusCallFlags.NONE, 10000, None)
