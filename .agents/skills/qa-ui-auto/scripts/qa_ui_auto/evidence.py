"""Failure evidence shared by browser and native steps.

An anchored terminal regex that never matches looks identical whether the
shell lost a line, the echo merged with the command, or the prompt never
appeared. Failures must carry the observed text so a hosted run is
diagnosable from its receipt instead of a rerun.
"""

from __future__ import annotations

TAIL_LINES = 12
TAIL_CHARS = 600


def text_tail(text: str | None, lines: int = TAIL_LINES, limit: int = TAIL_CHARS) -> str:
    """Return the tail of `text` as one repr-able line, or `<empty>`."""
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    kept = [row.rstrip() for row in normalized.split("\n")[-lines:] if row.strip()]
    if not kept:
        return "<empty>"
    tail = "\n".join(kept)
    if len(tail) > limit:
        tail = "..." + tail[-limit:]
    return repr(tail)