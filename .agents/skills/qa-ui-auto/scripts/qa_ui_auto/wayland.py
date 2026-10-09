"""Commands to the job-owned Mutter desktop; never use XWayland as fallback."""
from __future__ import annotations

import json
import os
import socket


def active() -> bool:
    return os.environ.get("GDK_BACKEND") == "wayland"


def command(name: str, **parameters):
    path = os.environ.get("QA_WAYLAND_INPUT_SOCKET")
    if not path:
        raise RuntimeError("Wayland OS automation requires the owned desktop input socket")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(30)
        connection.connect(path)
        connection.sendall(json.dumps({"command": name, **parameters}).encode() + b"\n")
        response = connection.makefile("rb").readline(1024 * 1024)
    result = json.loads(response)
    if result.get("ok") is not True:
        raise RuntimeError(f"Wayland {name} failed: {result.get('error', 'missing acknowledgement')}")
    return result.get("value")
