"""vnc_required: the scriptable VNC fixture is reachable; give the case its own
event log and command file. Skip the case otherwise (FixtureSkip).

Hosted CI starts `.agents/skills/vnc-realvnc-task/scripts/vnc_fixture_server.py`
(ci_services.Services.vnc) and fills `vnc.*`. Locally, start it yourself and
put host/port/control_port in the uncommitted config:

    QA_VNC_PASSWORD=<8 chars> python .agents/skills/vnc-realvnc-task/scripts/vnc_fixture_server.py \
        --port 5988 --control-port 5989 --security vncauth --password-env QA_VNC_PASSWORD \
        --ext-clipboard --clip-formats text,html

Every case starts from a fresh fixture (`reset`: no clients, start-up size).
Values for the steps (files live inside the report root, so the native
`host_write_file` / `assert_file_contains` verbs can reach them):

    ${fixture.vnc_host} / ${fixture.vnc_port}
    ${fixture.vnc_events}   one JSON line per client message of this case
                            (key, pointer, cut_text, ext_clipboard, ...)
    ${fixture.vnc_control}  overwrite with control lines (`resize W H`,
                            `cuttext TEXT`, `extclip TEXT`, `bell`, `drop`)
"""

from __future__ import annotations

import os
from pathlib import Path
import socket
from typing import Any


def control(host: str, port: int, *commands: str) -> list[str]:
    with socket.create_connection((host, port), timeout=5) as sock:
        sock.sendall(("\n".join(commands) + "\n").encode("utf-8"))
        sock.shutdown(socket.SHUT_WR)
        sock.settimeout(5)
        reply = b""
        while chunk := sock.recv(65536):
            reply += chunk
    return reply.decode("utf-8").splitlines()


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    section = (getattr(ctx, "cfg", {}) or {}).get("vnc") or {}
    host, port, control_port = section.get("host"), section.get("port"), section.get("control_port")
    if not host or not port or not control_port:
        raise FixtureSkip(
            "vnc.host / vnc.port / vnc.control_port not configured. Start "
            "vnc_fixture_server.py (see qa_ui_auto/fixtures/vnc_required.py) and set them in your "
            "local uncommitted qa-ui-auto.config.yaml; hosted CI provisions them automatically."
        )

    env = getattr(ctx, "env", None)
    password = (env or {}).get("QA_VNC_PASSWORD") or os.environ.get("QA_VNC_PASSWORD")
    raw = section.get("password")
    if not password and raw and not str(raw).startswith("${"):
        password = str(raw)
        os.environ["QA_VNC_PASSWORD"] = password
        if isinstance(env, dict):
            env["QA_VNC_PASSWORD"] = password
    if not password or not password.strip():
        raise FixtureSkip(
            "VNC fixture password is not configured. Set QA_VNC_PASSWORD to the password the "
            "fixture was started with. Do NOT commit passwords or credentials to version control."
        )

    # Absolute: the fixture process may run from another working directory.
    root = Path(ctx.case_dir).parent.resolve() / "vnc-fixture"
    root.mkdir(parents=True, exist_ok=True)
    events = root / f"{ctx.case_id}-events.jsonl"
    commands = root / f"{ctx.case_id}-control.txt"
    events.write_text("", encoding="utf-8")
    commands.write_text("", encoding="utf-8")
    try:
        replies = control(str(host), int(control_port), "reset", f"log {events}", f"watch {commands}")
        with socket.create_connection((str(host), int(port)), timeout=2.0):
            pass
    except OSError as exc:
        raise FixtureSkip(
            f"VNC fixture {host}:{port} (control {control_port}) unreachable ({exc}). "
            "Start vnc_fixture_server.py — qa-ui-auto does not auto-fallback."
        ) from exc
    if replies != ["ok", "ok", "ok"]:
        raise RuntimeError(f"VNC fixture control port answered {replies!r}; expected three 'ok'")
    ctx.values.update(vnc_host=str(host), vnc_port=str(port), vnc_events=str(events),
                      vnc_control=str(commands))
