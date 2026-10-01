"""ard_required: macOS Screen Sharing answers with ARD (Apple Remote Desktop)
login for a known account; skip the case otherwise (FixtureSkip).

Hosted CI enables Screen Sharing on macOS runners and creates a disposable
admin account (ci_services.Services.ard), filling `ard.*`; when that fails,
`ard.unavailable` carries the reason and the case fails.
Locally: enable Sharing > Screen Sharing on a Mac and set, in the uncommitted
config, `ard.host`, `ard.port` (5900), `ard.user` (the macOS account) and
`ard.password: ${env.QA_ARD_PASSWORD}`.

Values: ${fixture.ard_host}, ${fixture.ard_port}, ${fixture.ard_user}; the
password stays in QA_ARD_PASSWORD (${env.QA_ARD_PASSWORD} in steps).
"""

from __future__ import annotations

import os
import socket
from typing import Any


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    section = (getattr(ctx, "cfg", {}) or {}).get("ard") or {}
    if section.get("unavailable"):
        # Hosted CI asked for Screen Sharing and could not provide it: that is
        # a failed precondition, not a configuration gap to skip over.
        raise RuntimeError(f"macOS Screen Sharing provisioning failed: {section['unavailable']} "
                           "(see services/screensharing-diagnostics.txt)")
    host, port, user = section.get("host"), section.get("port"), section.get("user")
    if not host or not port or not user or not str(user).strip():
        raise FixtureSkip(
            "ard.host / ard.port / ard.user not configured: point them at macOS Screen Sharing in your "
            "local uncommitted qa-ui-auto.config.yaml; hosted CI provisions them on macOS runners."
        )
    env = getattr(ctx, "env", None)
    password = (env or {}).get("QA_ARD_PASSWORD") or os.environ.get("QA_ARD_PASSWORD")
    raw = section.get("password")
    if not password and raw and not str(raw).startswith("${"):
        password = str(raw)
        os.environ["QA_ARD_PASSWORD"] = password
        if isinstance(env, dict):
            env["QA_ARD_PASSWORD"] = password
    if not password or not password.strip():
        raise FixtureSkip(
            "macOS account password is not configured. Set QA_ARD_PASSWORD. "
            "Do NOT commit passwords or credentials to version control."
        )
    try:
        with socket.create_connection((str(host), int(port)), timeout=3.0) as sock:
            sock.settimeout(3.0)
            banner = sock.recv(12)
    except OSError as exc:
        raise FixtureSkip(f"Screen Sharing {host}:{port} unreachable ({exc}).") from exc
    if not banner.startswith(b"RFB 003."):
        raise FixtureSkip(f"{host}:{port} is not an RFB server (banner {banner[:12]!r}).")
    ctx.values.update(ard_host=str(host), ard_port=str(port), ard_user=str(user).strip())
