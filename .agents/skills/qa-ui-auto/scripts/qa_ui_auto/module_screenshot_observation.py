"""Bind Screenshot OCR execution to the installed signed host and its lease."""

import hashlib
import json

from .fixtures.backup_policy import isolated_data_root
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .steps import StepError


def run(ctx, phase):
    owner = ctx.fixture_context
    signed = getattr(owner, "signed_screenshot", None)
    if phase not in {"idle", "running", "disabled"} or not signed or owner.case_id not in {"TC-MODULES-061", "TC-MODULES-062"}:
        raise StepError("The Screenshot host observation requires its signed native case")

    plugins = isolated_data_root(owner) / "plugins"
    module = plugins / "screenshot"
    receipt = signed["receipt"]
    pointer = module / "active.json"
    ordinary(pointer)
    active = json.loads(pointer.read_text(encoding="utf-8"))
    if active.get("activeVersion") != receipt["version"]:
        raise StepError("Screenshot selected a different package version")
    executable = module / "versions" / receipt["version"] / signed["host"]
    ordinary(executable)
    with executable.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != receipt["hostSha256"]:
        raise StepError("The installed Screenshot host differs from the signed archive")

    lease = writer_lease(plugins, slug="screenshot", enabled=phase == "running")
    evidence = {"phase": phase, "sourceSha": receipt["sourceSha"], "platform": receipt["platform"],
                "packageSha256": receipt["sha256"], "hostSha256": digest, "writerLease": lease}
    (ctx.case_dir / f"signed-screenshot-{phase}.json").write_text(
        json.dumps(evidence, indent=2) + "\n", encoding="utf-8",
    )
    return f"Signed Screenshot host {phase}, writer lease verified"
