"""Profile and loopback observations for the signed remote desktop cases."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import platform
import re
import socket
import sqlite3
import time

from .module_mfa_lifecycle_observation import digest
from .module_rdp_server_observation import observe_settings as observe_rdp_settings
from .module_retained_observation import ordinary
from .module_vnc_server_observation import observe_listener, observe_settings as observe_vnc_settings
from .steps import StepError


CLIENTS = {
    "vnc-client": "VNC",
    "rdp-client": "RDP",
}
SERVER_FILES = {
    "rdp-server": {("config.json", "file"), ("cert.pem", "file"), ("key.pem", "file")},
    "vnc-server": {("config.json", "file")},
}
SERVICE_RUNNING_PHASES = {"old-enabled", "old-reenabled", "reinstalled"}


def _query(path, sql, params):
    ordinary(path)
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        return db.execute(sql, params).fetchall()


def _logical_digest(rows):
    return hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()


def client_data(owner, slug, module):
    protocol = CLIENTS[slug]
    profile = module.parent.parent
    if protocol == "VNC":
        host, port = owner.values["vnc_host"], int(owner.values["vnc_port"])
    else:
        host, port = "127.0.0.1", int(owner.values["rdp_port"])
    sessions = _query(
        profile / "taomni.db",
        "SELECT id, host, port FROM sessions WHERE name=? AND session_type=?",
        (f"qa-lifecycle-{protocol.lower()}", protocol),
    )
    if len(sessions) != 1 or sessions[0][1:] != (host, port):
        raise StepError(f"The saved {protocol} session drifted or disappeared")
    evidence = {"sessionSha256": _logical_digest(sessions), "endpoint": f"{host}:{port}"}
    if protocol == "RDP":
        pins = _query(
            module / "data/data.db",
            "SELECT fingerprint FROM rdp_certificate_pins WHERE endpoint=?",
            (evidence["endpoint"],),
        )
        if len(pins) != 1 or not re.fullmatch(r"[0-9a-f]{64}", pins[0][0]):
            raise StepError("The saved RDP endpoint did not retain its accepted certificate")
        evidence["pinsSha256"] = _logical_digest(pins)
    return evidence


def server_data(owner, slug, module):
    profile = module.parent.parent
    if slug == "vnc-server":
        return observe_vnc_settings(profile, owner.signed_vnc_daemon, "running")
    config_digest = observe_rdp_settings(profile, owner.signed_rdp_server, "running")
    return {"configSha256": config_digest, "certificateSha256": digest(module / "data/cert.pem"),
            "keySha256": digest(module / "data/key.pem")}


def vnc_client_connection(owner, phase):
    path = Path(owner.values["vnc_events"])
    expected = 1 if phase in SERVICE_RUNNING_PHASES else 0
    until = time.monotonic() + 10
    while True:
        if path.exists():
            with path.open(encoding="utf-8") as stream:
                # The fixture can append a line concurrently. A partial final
                # record will be read on the next observation.
                events = [json.loads(line) for line in stream if line.endswith("\n")]
            initialized = {entry["conn"] for entry in events if entry["type"] == "client_init"}
            closed = {entry["conn"] for entry in events if entry["type"] == "session_closed"}
            if initialized and len(initialized - closed) == expected:
                return {"active": sorted(initialized - closed), "closed": sorted(initialized & closed)}
        if time.monotonic() >= until:
            raise StepError(f"VNC fixture did not observe {expected} remaining authenticated connections")
        time.sleep(0.15)


def _rdp_listener(port):
    deadline = time.monotonic() + 10
    while True:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return
        except (ConnectionRefusedError, TimeoutError):
            if time.monotonic() >= deadline:
                raise StepError("The signed RDP Server did not open its loopback listener") from None
            time.sleep(0.15)


def server_runtime(ctx, slug, phase, host):
    owner = ctx.fixture_context
    system = platform.system()
    started = phase in SERVICE_RUNNING_PHASES
    if slug == "rdp-server":
        port = owner.signed_rdp_server["port"]
        if started:
            _rdp_listener(port)
        else:
            observe_listener(port, expect_rfb=False)
        return {"port": port, "listening": started}

    port = owner.signed_vnc_daemon["port"]
    if system != "Linux":
        observe_listener(port, expect_rfb=False)
        message = {"Darwin": "Taomni cannot start it for you.", "Windows": "No VNC server found in PATH"}[system]
        if started and message not in ctx.session.text('[data-testid="server-log"]'):
            raise StepError("The signed VNC Server did not show the platform's setup guidance")
        return {"port": port, "listening": False, "platformGuidance": message if started else None}

    import psutil
    from native_qa_bridge import identity

    listener = observe_listener(port, expect_rfb=started)
    previous = getattr(owner, "vnc_lifecycle_daemon", None)
    if previous and identity(previous["pid"]) == previous:
        raise StepError("The previous x11vnc child remained alive after the module changed")
    daemon = None
    if started:
        from ci_services import rfb_probe

        children = psutil.Process(host["pid"]).children()
        instances = [child for child in children if child.name() == "x11vnc"]
        if len(instances) != 1 or (daemon := identity(instances[0].pid)) is None:
            raise StepError("The current signed VNC host did not own the active x11vnc child")
        password = json.loads(owner.signed_vnc_daemon["legacy_settings"])["password"]
        width, height, _ = rfb_probe(port, password)
        if width <= 0 or height <= 0:
            raise StepError("VNC Server returned an empty framebuffer after authentication")
        listener["desktopSize"] = [width, height]
    owner.vnc_lifecycle_daemon = daemon
    return {"port": port, "listening": listener is not None, "rfb": listener, "daemon": daemon}
