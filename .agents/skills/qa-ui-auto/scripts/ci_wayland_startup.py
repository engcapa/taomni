"""Observe GNOME startup before changing the owned compositor's output layout."""
from __future__ import annotations

from collections.abc import Callable
import json
from pathlib import Path
import time
from typing import Any


SHELL_STARTUP = """(() => {
    const layout = Main.layoutManager;
    if (layout._startingUp === false && Main.overview.visible)
        Main.overview.hide();
    return {
        starting_up: layout._startingUp,
        window_clip: global.window_group.has_clip ? global.window_group.get_clip() : null,
        overview: Main.overview.visible || Main.overview.animationInProgress || layout.overviewGroup.visible
    };
})()"""


def wait_for_shell_startup(evaluate: Callable[[str], Any], report: Path,
                          *, timeout: float = 30) -> dict:
    # Shell acquires Mutter's DBus names before finishing its startup animation.
    # Changing outputs then can cancel background loading while the window group
    # still has its old primary-monitor clip. Geometry and GTK draws remain valid,
    # but GNOME and application screenshots both contain the clipped desktop.
    started = time.monotonic()
    observations = []
    while True:
        try:
            state = evaluate(SHELL_STARTUP)
            ready = (isinstance(state, dict) and state.get("starting_up") is False
                     and "window_clip" in state and state["window_clip"] is None
                     and state.get("overview") is False)
        except (OSError, RuntimeError) as error:
            state, ready = {"error": str(error)}, False
        elapsed = time.monotonic() - started
        observations.append({"elapsed_sec": elapsed, "state": state})
        report.write_text(json.dumps({"ready": ready, "observations": observations}, indent=2))
        if ready:
            return state
        if elapsed >= timeout:
            raise RuntimeError(f"GNOME startup did not finish before output configuration: {state}; see {report}")
        time.sleep(0.25)
