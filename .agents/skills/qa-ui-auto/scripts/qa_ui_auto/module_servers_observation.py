"""Verify the independently packaged Local servers host and teardown."""

import hashlib
import json

from .fixtures.backup_policy import isolated_data_root
from .fixtures.module_signed_archive import SERVERS_CASE
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .servers_http_observation import run as observe_http
from .steps import StepError


def run(ctx, phase):
    fixture = ctx.fixture_context
    signed = getattr(fixture, "signed_servers", None)
    if fixture.case_id != SERVERS_CASE or not signed or phase not in {"running", "disabled"}:
        raise StepError("The Local servers observation requires its signed native case")
    plugins = isolated_data_root(fixture) / "plugins"
    module = plugins / "servers"
    receipt = signed["receipt"]
    pointer = module / "active.json"
    ordinary(pointer)
    if json.loads(pointer.read_text(encoding="utf-8")).get("activeVersion") != receipt["version"]:
        raise StepError("Local servers selected a different signed package version")
    executable = module / "versions" / receipt["version"] / signed["host"]
    ordinary(executable)
    with executable.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != receipt["hostSha256"]:
        raise StepError("Installed Local servers host differs from the signed archive")
    running = phase == "running"
    observation = observe_http(ctx, "serving" if running else "stopped")
    lease = writer_lease(plugins, slug="servers", enabled=running)
    evidence = {
        "sourceSha": receipt["sourceSha"], "platform": receipt["platform"], "phase": phase,
        "hostSha256": digest, "packageSha256": receipt["sha256"], "writerLease": lease, "http": observation,
    }
    (ctx.case_dir / f"signed-servers-{phase}.json").write_text(
        json.dumps(evidence, indent=2) + "\n", encoding="utf-8",
    )
    return observation
