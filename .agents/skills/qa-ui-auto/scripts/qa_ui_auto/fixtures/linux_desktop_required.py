"""Require native Linux clipboard/input/IME tools for the effective desktop."""
import os
import platform
import shutil


def setup(ctx):
    from . import FixtureSkip
    if os.environ.get("GDK_BACKEND") != "wayland":
        from .linux_x11_required import setup as x11_setup
        return x11_setup(ctx)
    required = ("wl-copy", "wl-paste", "fcitx5-remote", "gdbus", "/usr/bin/python3")
    missing = [name for name in required if shutil.which(name) is None]
    if platform.system() != "Linux" or not os.environ.get("QA_WAYLAND_INPUT_SOCKET") or missing:
        raise FixtureSkip(f"owned Wayland clipboard/input desktop unavailable; missing: {missing}")
