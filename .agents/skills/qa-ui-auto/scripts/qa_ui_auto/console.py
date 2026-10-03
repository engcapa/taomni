"""Console setup shared by qa-ui-auto command-line entry points."""

from __future__ import annotations

import sys


def configure_console_encoding() -> None:
    """Keep Unicode reports printable on Windows and redirected streams."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except (OSError, ValueError):
            pass
