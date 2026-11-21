"""Observe the real signed Mail host and its data lease in an isolated profile."""

import hashlib
import json

from .fixtures.backup_policy import isolated_data_root
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .steps import StepError


def run(ctx, phase):
    owner = ctx.fixture_context
    signed = getattr(owner, "signed_mail", None)
    active = {"folder-tree", "running", "imap-delivery", "pop3-delivery", "imap-search", "imap-flags"}
    if phase not in active | {"idle", "disabled"} or not signed or owner.case_id != "TC-MODULES-059":
        raise StepError("The Mail host observation requires the registered signed native case")
    plugins = isolated_data_root(owner) / "plugins"
    receipt = signed["receipt"]
    module = plugins / "mail"
    pointer_path = module / "active.json"
    ordinary(pointer_path)
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    version = receipt["version"]
    if pointer.get("activeVersion") != version:
        raise StepError("The native Mail install selected another version")
    version_root = module / "versions" / version
    host = version_root / signed["host"]
    ordinary(host)
    with host.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != receipt["hostSha256"]:
        raise StepError("The installed Mail host differs from the verified package")
    frontend = version_root / signed["frontend"]
    ordinary(frontend)
    with frontend.open("rb") as entry:
        frontend_digest = hashlib.file_digest(entry, "sha256").hexdigest()
    if frontend_digest != receipt["frontendSha256"]:
        raise StepError("The installed Mail frontend differs from the verified package")
    observed = writer_lease(plugins, slug="mail", enabled=phase in active)
    report = {"phase": phase, "sourceSha": receipt["sourceSha"], "platform": receipt["platform"],
              "packageSha256": receipt["sha256"], "hostSha256": digest,
              "frontendSha256": frontend_digest, "writerLease": observed}
    (ctx.case_dir / f"signed-mail-{phase}.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return f"Mail {version} host lease verified ({phase})"
