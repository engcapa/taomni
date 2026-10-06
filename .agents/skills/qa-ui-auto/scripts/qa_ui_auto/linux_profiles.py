"""Named, reproducible Linux native desktops for the hosted QA matrix.

These profiles are independent of service fixtures (including vnc_required,
which tests the app's VNC client rather than hosting the app's desktop).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LinuxProfile:
    runner: str
    version_id: str
    session_type: str
    desktop: str
    display_server: str
    compositor: str
    wrapper: str

    def identity(self, name: str) -> dict:
        return {"profile": name, "os_id": "ubuntu", "version_id": self.version_id,
                "session_type": self.session_type, "desktop": self.desktop,
                "display_server": self.display_server, "compositor": self.compositor}


DEFAULT_LINUX_PROFILE = "ubuntu-24.04-xvfb"
LINUX_PROFILES = {
    DEFAULT_LINUX_PROFILE: LinuxProfile("ubuntu-24.04", "24.04", "x11", "Openbox", "Xvfb", "xcompmgr", "xvfb"),
    "ubuntu-22.04-x11": LinuxProfile("ubuntu-22.04", "22.04", "x11", "LXQt/Openbox", "Xvfb", "xcompmgr", "xvfb"),
    "ubuntu-22.04-vnc": LinuxProfile("ubuntu-22.04", "22.04", "x11", "LXQt/Openbox", "Xtigervnc", "xcompmgr", "dbus"),
    "ubuntu-26.04-wayland": LinuxProfile("ubuntu-26.04", "26.04", "wayland", "GNOME", "Mutter", "Mutter", "dbus"),
}

# These helpers use Xlib/XTEST, an X11 selection owner or an X11 Tk window.
# Their Linux OS declaration alone cannot establish Wayland support.
X11_VERBS = {"native_click", "native_pointer_drag", "native_window_drag", "native_ime_keys",
             "native_clipboard_owner", "native_clipboard_image", "assert_system_clipboard",
             "native_show_image_window", "mouse_button", "host_clipboard"}


def profile_support(case, name: str) -> str | None:
    if LINUX_PROFILES[name].session_type != "wayland":
        return None
    if "linux_x11_required" in case.fixtures:
        return "case requires an X11 desktop (linux_x11_required)"
    if set(case.fixtures) & {"rdp_server_required", "rdp_baseline_required", "rdp_audio_required"}:
        return "Wayland RDP sharing requires portal consent automation; not provided by this profile yet"
    for step in case.steps:
        verb, args = next(iter(step.items()))
        if verb in X11_VERBS:
            return f"{verb} currently uses X11 OS automation; a Wayland helper is required"
        if verb == "native_keys" and (not isinstance(args, dict) or args.get("transport", "x11") == "x11"):
            return "native_keys selects the X11/XTEST transport"
        if verb == "native_screenshot_scenario" and args.get("scenario") != "pin-arrangement":
            return "Wayland capture scenarios require portal consent automation; not provided by this profile yet"
    return None
