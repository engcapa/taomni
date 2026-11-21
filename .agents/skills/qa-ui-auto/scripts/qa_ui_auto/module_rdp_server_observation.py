"""Check the real installed RDP Server and record the lifecycle evidence."""

import hashlib
import json
import os
import socket

from .fixtures.backup_policy import isolated_data_root
from .fixtures.module_signed_archive import RDP_SERVER_CASE
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .steps import StepError


def run(ctx, phase):
    fixture = ctx.fixture_context
    signed = getattr(fixture, "signed_rdp_server", None)
    if phase not in {"running", "disabled"} or not signed or fixture.case_id != RDP_SERVER_CASE:
        raise StepError("The RDP Server observation requires its signed native case")
    plugins = isolated_data_root(fixture) / "plugins"
    module = plugins / "rdp-server"
    receipt = signed["receipt"]
    pointer = module / "active.json"
    ordinary(pointer)
    if json.loads(pointer.read_text(encoding="utf-8")).get("activeVersion") != receipt["version"]:
        raise StepError("RDP Server selected a different signed package version")
    executable = module / "versions" / receipt["version"] / signed["host"]
    ordinary(executable)
    with executable.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != receipt["hostSha256"]:
        raise StepError("RDP Server installed bytes differ from the signed archive")
    port = int(os.environ["QA_RDP_PORT"])
    with socket.socket() as client:
        client.settimeout(1)
        listening = client.connect_ex(("127.0.0.1", port)) == 0
    if listening != (phase == "running"):
        raise StepError(f"Unexpected loopback RDP listener state for {phase}")
    cert = module / "data/cert.pem"
    key = module / "data/key.pem"
    for path in (cert, key):
        ordinary(path)
    lease = writer_lease(plugins, enabled=phase == "running", slug="rdp-server")
    evidence = {
        "phase": phase, "sourceSha": receipt["sourceSha"], "platform": receipt["platform"],
        "hostSha256": digest, "packageSha256": receipt["sha256"], "writerLease": lease,
        "listener": listening, "port": port, "certificateSha256": hashlib.sha256(cert.read_bytes()).hexdigest(),
    }
    (ctx.case_dir / f"signed-rdp-server-{phase}.json").write_text(
        json.dumps(evidence, indent=2) + "\n", encoding="utf-8",
    )
    return f"Verified signed RDP Server {phase}"
