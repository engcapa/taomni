"""Operate the QA-owned GTK chooser through the private Mutter input session."""
from pathlib import Path

from . import wayland
from .deadline import budget_time as time
from .steps import StepError


def operate(ctx, path: Path | None, title: str) -> dict:
    application = str(Path(ctx.session.application).resolve())

    def geometry():
        try:
            return wayland.command("geometry", application=application, title=title)
        except RuntimeError as error:
            # Missing is the expected state before mapping and after closing.
            # A dead compositor/socket or ambiguous ownership remains fatal.
            if "found 0" in str(error):
                return None
            raise

    deadline = time.monotonic() + 20
    window = geometry()
    while window is None and time.monotonic() < deadline:
        time.sleep(0.1)
        window = geometry()
    if window is None:
        raise StepError("native_folder_dialog: no owned Wayland chooser appeared")
    wayland.command("activate", application=application, title=title)
    if path is None:
        wayland.command("keys", chords=[[0xff1b]])  # Escape
    else:
        # GTK's location entry accepts the requested directory directly, just
        # as on X11. Never select its first child after navigating with Enter.
        wayland.command("keys", chords=[[0xffe9, 0xff50]])  # Alt+Home
        time.sleep(0.25)
        wayland.command("keys", chords=[[0xffe3, ord("l")]])
        wayland.command("text", text=str(path))
        wayland.command("keys", chords=[[0xffe9, ord("o")]])
    deadline = time.monotonic() + 10
    while geometry() is not None:
        if time.monotonic() >= deadline:
            raise StepError("native_folder_dialog: owned Wayland chooser did not close")
        time.sleep(0.25)
        if path is not None and geometry() is not None:
            wayland.command("keys", chords=[[0xffe9, ord("o")]])
    return {"transport": "Mutter OS keyboard", "application": application,
            "pid": window["pid"], "window": window}
