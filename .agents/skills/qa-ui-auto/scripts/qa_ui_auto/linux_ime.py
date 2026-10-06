"""Observe the active fcitx5 engine through its stable DBus controller API."""
from __future__ import annotations

import ast
import subprocess


def current_fcitx_engine(*, env=None, timeout=5) -> str:
    # Jammy's fcitx5 5.0.14 exposes this method but its remote CLI has no -n.
    # Read the daemon's actual engine, rather than inferring it from its config.
    output = subprocess.check_output([
        "gdbus", "call", "--session", "--dest", "org.fcitx.Fcitx5",
        "--object-path", "/controller", "--method",
        "org.fcitx.Fcitx.Controller1.CurrentInputMethod",
    ], env=env, text=True, timeout=timeout, stderr=subprocess.PIPE)
    try:
        reply = ast.literal_eval(output.strip())
    except (ValueError, SyntaxError) as exc:
        raise RuntimeError(f"invalid fcitx5 current engine reply: {output!r}") from exc
    if not isinstance(reply, tuple) or len(reply) != 1 or not isinstance(reply[0], str):
        raise RuntimeError(f"invalid fcitx5 current engine reply: {output!r}")
    return reply[0]
