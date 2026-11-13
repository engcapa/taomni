"""Balanced non-left clicks on the owned X11 window, not GTK W3C button state."""
from __future__ import annotations

from contextlib import suppress
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import time
from typing import Any, Callable, Protocol

from native_webdriver_transport import WebDriverError
from native_window_close_x11 import managed_windows
from qa_ui_auto.window_drag import command, window_geometry


class ButtonSession(Protocol):
    application: Path
    session_id: str | None
    pointer_observations_path: Path | None
    last_pointer_click: dict[str, Any]

    def endpoint(self, suffix: str) -> str: ...
    def request(self, method: str, path: str, payload: dict | None = None) -> Any: ...


NATIVE_WINDOW = r"""
const done = arguments[arguments.length - 1];
try {
  const api = window.__TAURI_INTERNALS__;
  api.invoke('plugin:window|title', {label: api.metadata.currentWindow.label})
    .then(title => done({title, width: innerWidth, height: innerHeight}),
          error => done({error: String(error)}));
} catch (error) { done({error: String(error)}); }
"""


@dataclass(frozen=True)
class X11ButtonTarget:
    window_id: str
    pid: int
    application: Path
    data_home: str
    title: str
    geometry: dict[str, int]
    viewport: dict[str, Any]
    point: dict[str, int]
    local_point: dict[str, int]


def require_x11_button_input(modifiers: list[str]) -> None:
    backend = os.environ.get("GDK_BACKEND", "").split(",")[0]
    if (not os.environ.get("DISPLAY") or backend not in {"", "x11"}
            or (not backend and os.environ.get("XDG_SESSION_TYPE") == "wayland")):
        raise WebDriverError("Linux non-left pointer input requires an owned X11 desktop; no W3C fallback")
    if modifiers:
        raise WebDriverError("Linux non-left X11 clicks do not support modifiers")


def _owned_process(application: Path, data_home: str, pid: int,
                   proc_root: Path = Path("/proc")) -> bool:
    try:
        entry = proc_root / str(pid)
        return ((entry / "exe").resolve(strict=True) == application.resolve(strict=True)
                and b"XDG_DATA_HOME=" + data_home.encode() in (entry / "environ").read_bytes().split(b"\0"))
    except OSError:
        return False


def _owned_window(application: Path, data_home: str, title: str) -> tuple[str, int]:
    matches = [(window, pid) for window, pid in managed_windows()
               if _owned_process(application, data_home, pid)
               and command("xdotool", "getwindowname", window).strip() == title]
    if len(matches) != 1:
        raise WebDriverError(f"Linux non-left click needs one exact QA profile/window; found {len(matches)}")
    return matches[0]


def _native_window(session: ButtonSession) -> dict[str, Any]:
    value = session.request("POST", session.endpoint("/execute/async"),
                            {"script": NATIVE_WINDOW, "args": []})
    if (not isinstance(value, dict) or not isinstance(value.get("title"), str) or not value["title"]
            or any(type(value.get(k)) not in (int, float) or not math.isfinite(value[k])
                   or value[k] <= 0 for k in ("width", "height"))):
        detail = ({"error": value.get("error"), "title_present": bool(value.get("title")),
                   "width": value.get("width"), "height": value.get("height")}
                  if isinstance(value, dict) else {"response_type": type(value).__name__})
        raise WebDriverError(f"Linux non-left click could not identify the native window/viewport: {detail}")
    return value


def _move_physical_pointer(window: str, geometry: dict[str, int], point: dict[str, int]) -> None:
    # xdotool --sync waits for a MotionNotify change, so moving to the current
    # terminal position can wait forever. Send the one hover without that flag
    # and independently read its actual root coordinates, including no-op moves.
    command("xdotool", "mousemove", "--window", window, str(point["x"]), str(point["y"]))
    fields = dict(line.split("=", 1) for line in command("xdotool", "getmouselocation", "--shell").splitlines() if "=" in line)
    try:
        actual = {axis: int(fields[axis.upper()]) for axis in ("x", "y")}
    except (KeyError, ValueError) as error:
        raise WebDriverError("Linux non-left click could not observe physical pointer position") from error
    expected = {axis: geometry[axis] + point[axis] for axis in ("x", "y")}
    if actual != expected:
        raise WebDriverError(f"Linux non-left pointer did not reach the owned target: {actual}; expected {expected}")


def prepare_x11_button_target(session: ButtonSession, origin: dict, *, data_home: str | None,
                              allow_alternate: bool, prepare_target: Callable[..., dict]) -> X11ButtonTarget:
    """Own and hover the physical pointer before authorizing any button input."""
    if not data_home:
        raise WebDriverError("Linux non-left click requires the session's isolated XDG_DATA_HOME")
    viewport = _native_window(session)
    window, pid = _owned_window(session.application, data_home, viewport["title"])
    command("wmctrl", "-ia", window)
    command("xdotool", "windowfocus", "--sync", window)
    for _ in range(3):
        point = prepare_target(session, origin, allow_alternate=allow_alternate)
        viewport = _native_window(session)
        geometry = window_geometry(window)
        if (any(type(geometry.get(k)) is not int for k in ("x", "y", "width", "height"))
                or geometry["width"] <= 0 or geometry["height"] <= 0
                or any(not 0 <= point[k] < viewport[dimension]
                       for k, dimension in (("x", "width"), ("y", "height")))):
            raise WebDriverError("Linux non-left click has invalid native target geometry")
        local = {k: round(point[k] * geometry[dimension] / viewport[dimension])
                 for k, dimension in (("x", "width"), ("y", "height"))}
        _move_physical_pointer(window, geometry, local)
        # OS hover (unlike a W3C move) can open native popups or change layout.
        # Only hover/preparation can repeat; the balanced click is outside this loop.
        if (prepare_target(session, origin, allow_alternate=allow_alternate) == point
                and _native_window(session) == viewport and window_geometry(window) == geometry):
            return X11ButtonTarget(window, pid, session.application, data_home,
                                   viewport["title"], geometry, viewport, point, local)
    raise WebDriverError("Linux non-left click target moved during physical pointer preparation")


def click_x11_button(session: ButtonSession, target: X11ButtonTarget, button: int,
                     *, selector: str) -> dict[str, Any]:
    """Never send a W3C non-left down, including on an uncertain OS failure.

    WebKitGTK 2.52 Session::performActions drops pressedButton on pointerUp;
    GTK maps the resulting None to PRIMARY, leaving right/middle held in
    m_currentModifiers. ReleaseActions resets sources without a mouse Up.
    Use the existing X11 transport for the entire balanced non-left click.
    """
    observation = {"transport": "X11 xdotool -> GTK/WebKitGTK", "button": button,
                   "session_id": session.session_id, "selector": selector,
                   "started_at_unix_ms": round(time.time() * 1000),
                   "window_id": target.window_id, "pid": target.pid,
                   "point": target.point, "local_point": target.local_point,
                   "status": "preparing"}
    session.last_pointer_click = observation
    try:
        # Do not select another same-title process, profile or detached window.
        if (_owned_window(target.application, target.data_home, target.title)
                != (target.window_id, target.pid)
                or _native_window(session) != target.viewport
                or window_geometry(target.window_id) != target.geometry
                or int(command("xdotool", "getactivewindow").strip(), 0) != int(target.window_id, 16)):
            raise WebDriverError("Linux non-left click native window changed before input")
        xbutton = {1: "2", 2: "3"}[button]
        observation["status"] = "input-started"
        try:
            command("xdotool", "click", xbutton)
        except BaseException:
            # Delivery may have stopped after down. Release only; never replay.
            with suppress(Exception):
                command("xdotool", "mouseup", xbutton)
            raise
    except BaseException as error:
        observation.update(status="failed", error_type=type(error).__name__)
        raise
    else:
        observation["status"] = "completed"
    finally:
        observation["finished_at_unix_ms"] = round(time.time() * 1000)
        if session.pointer_observations_path is not None:
            # Diagnostics must not mask an uncertain input error. Omit titles,
            # profile paths and DOM content; the selector joins the case trace.
            with suppress(Exception):
                with session.pointer_observations_path.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(observation) + "\n")
    return observation
