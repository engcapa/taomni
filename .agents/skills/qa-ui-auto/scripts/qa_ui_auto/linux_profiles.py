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

    def identity(self, name: str, *, dual_display: bool = False) -> dict:
        # The dual-display fixture replaces the profile's single-screen X
        # server with a job-owned Xorg dummy server so RandR exposes two real
        # outputs. Keep the selected profile metadata while binding the
        # expected display server to the desktop that actually runs cases.
        display_server = "Xorg dummy" if dual_display and self.session_type == "x11" else self.display_server
        return {"profile": name, "os_id": "ubuntu", "version_id": self.version_id,
                "session_type": self.session_type, "desktop": self.desktop,
                "display_server": display_server, "compositor": self.compositor}


DEFAULT_LINUX_PROFILE = "ubuntu-24.04-xvfb"
LINUX_PROFILES = {
    DEFAULT_LINUX_PROFILE: LinuxProfile("ubuntu-24.04", "24.04", "x11", "Openbox", "Xvfb", "xcompmgr", "xvfb"),
    "ubuntu-22.04-x11": LinuxProfile("ubuntu-22.04", "22.04", "x11", "LXQt/Openbox", "Xvfb", "xcompmgr", "xvfb"),
    "ubuntu-22.04-vnc": LinuxProfile("ubuntu-22.04", "22.04", "x11", "LXQt/Openbox", "Xtigervnc", "xcompmgr", "dbus"),
    "ubuntu-26.04-wayland": LinuxProfile("ubuntu-26.04", "26.04", "wayland", "GNOME", "Mutter", "Mutter", "dbus"),
}

def profile_support(case, name: str) -> str | None:
    if LINUX_PROFILES[name].session_type != "wayland":
        return None
    if "linux_x11_required" in case.fixtures:
        return "case requires an X11 desktop (linux_x11_required)"
    return None
