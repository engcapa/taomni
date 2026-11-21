"""Observe the actual local daemon launched by the verified VNC module."""

import hashlib
import json
import socket
import time

from .fixtures.backup_policy import isolated_data_root
from .fixtures.module_signed_archive import VNC_SERVER_CASE
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .steps import StepError


def run(ctx, phase):
    owner = ctx.fixture_context
    signed = getattr(owner, "signed_vnc_daemon", None)
    if phase not in {"idle", "running", "stopped", "disabled"} or not signed or owner.case_id != VNC_SERVER_CASE:
        raise StepError("The VNC daemon observation requires its signed native case")

    plugins = isolated_data_root(owner) / "plugins"
    module = plugins / "vnc-server"
    receipt = signed["receipt"]
    pointer = module / "active.json"
    ordinary(pointer)
    if json.loads(pointer.read_text(encoding="utf-8")).get("activeVersion") != receipt["version"]:
        raise StepError("VNC Server selected a different package version")
    executable = module / "versions" / receipt["version"] / signed["host"]
    ordinary(executable)
    with executable.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != receipt["hostSha256"]:
        raise StepError("The installed VNC Server host differs from the signed archive")

    lease = writer_lease(plugins, slug="vnc-server", enabled=phase in {"running", "stopped"})
    banner = observe_listener(signed["port"], expect_rfb=phase == "running")
    evidence = {"phase": phase, "sourceSha": receipt["sourceSha"], "platform": receipt["platform"],
                "packageSha256": receipt["sha256"], "hostSha256": digest, "writerLease": lease,
                "localPort": signed["port"], "banner": banner}
    index = len(list(ctx.case_dir.glob("signed-vnc-daemon-*.json"))) + 1
    (ctx.case_dir / f"signed-vnc-daemon-{index:02}-{phase}.json").write_text(
        json.dumps(evidence, indent=2) + "\n", encoding="utf-8",
    )
    return f"Verified VNC daemon {phase} on the isolated loopback port"


def observe_listener(port, *, expect_rfb):
    deadline = time.monotonic() + 10
    while True:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1) as peer:
                if expect_rfb:
                    with peer.makefile("rb") as stream:
                        data = stream.readline(32)
                    if data.startswith(b"RFB ") and data.endswith(b"\n"):
                        return data.decode("ascii").strip()
        except ConnectionRefusedError:
            if not expect_rfb:
                return None
        except TimeoutError:
            pass
        if time.monotonic() >= deadline:
            raise StepError("VNC daemon did not reach the expected listening state")
        time.sleep(0.15)
