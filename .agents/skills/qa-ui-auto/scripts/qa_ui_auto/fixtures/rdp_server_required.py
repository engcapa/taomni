"""rdp_server_required: native environment for RDP server/client cases.

Provides disposable credentials and a free loopback port for the Taomni RDP
server a case starts through the Local servers UI, and checks that the
QA-only ``rdp-probe`` binary and the stdlib-Tk target helper are available.

Exposed to steps through the environment (``${env.QA_RDP_*}``) because the
probe receives the password only by variable name:

* ``QA_RDP_USER`` / ``QA_RDP_PASSWORD`` - server account entered in the UI
* ``QA_RDP_BAD_PASSWORD`` - a different password for the rejection check
* ``QA_RDP_PORT`` - free 127.0.0.1 port (never 3389, which a host RDP may own)
* ``QA_VAULT_PASSWORD`` - master password for the fresh isolated vault

Browser mode: FixtureSkip - neither the server nor the probe exists there.
"""

from __future__ import annotations

import os
import platform
import secrets
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _secret(name: str, ctx: Any) -> str:
    value = os.environ.get(name) or ("Qa1_" + secrets.token_hex(12))
    _export(name, value, ctx)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{value}", flush=True)
    return value


def _export(name: str, value: str, ctx: Any) -> None:
    os.environ[name] = value
    env = getattr(ctx, "env", None)
    if isinstance(env, dict):
        env[name] = value


def probe_binary(cfg: dict) -> Path:
    configured = (cfg.get("app") or {}).get("native_binary")
    if configured:
        base = Path(str(configured)).expanduser().resolve().parent
    else:
        scripts = Path(__file__).resolve().parents[2]
        sys.path.insert(0, str(scripts))
        from native_build import qa_binary  # type: ignore[import-not-found]

        base = qa_binary().parent
    return base / ("rdp-probe.exe" if platform.system() == "Windows" else "rdp-probe")


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    if (cfg.get("app") or {}).get("mode", "browser") != "native":
        raise FixtureSkip("RDP server cases need the packaged native app and rdp-probe")
    probe = probe_binary(cfg)
    if not probe.is_file():
        # A missing probe means the QA build did not produce it: an
        # infrastructure failure, not an environment the case may skip.
        raise RuntimeError(f"rdp-probe binary missing next to the QA app: {probe}")
    tk = subprocess.run([sys.executable, "-c", "import tkinter; tkinter.Tcl()"],
                        capture_output=True, text=True, timeout=30)
    if tk.returncode:
        raise FixtureSkip(f"Python tkinter is unavailable for the RDP target helper: {tk.stderr[-300:]}")

    _export("QA_RDP_USER", os.environ.get("QA_RDP_USER") or "qa-rdp", ctx)
    _secret("QA_RDP_PASSWORD", ctx)
    _secret("QA_RDP_BAD_PASSWORD", ctx)
    _secret("QA_VAULT_PASSWORD", ctx)
    port = os.environ.get("QA_RDP_PORT_FIXED") or str(_free_port())
    _export("QA_RDP_PORT", port, ctx)
    values = getattr(ctx, "values", None)
    if isinstance(values, dict):
        values["rdp_port"] = port
        values["rdp_probe"] = probe.as_posix()
