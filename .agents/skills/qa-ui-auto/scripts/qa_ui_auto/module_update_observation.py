"""Compare signed versions, actual host identity and writer ownership across updates."""
import hashlib
import json
from pathlib import Path

from .module_profile_observation import writer_lease
from .module_signed_observation import invoke
from .steps import StepError

VERSION_STATES = {
    "old-enabled": ("0.0.9", None, "enabled"),
    "updated-disabled": ("0.1.0", "0.0.9", "disabled"),
    "old-disabled": ("0.0.9", "0.1.0", "disabled"),
    "updated-enabled": ("0.1.0", "0.0.9", "enabled"),
    "failed-update": ("0.1.0", "0.0.9", "enabled"),
    "rolled-back-enabled": ("0.0.9", "0.1.0", "enabled"),
}


def observe(ctx, root, phase, origin):
    if getattr(ctx.fixture_context, "case_id", None) != "TC-MODULES-042":
        raise StepError("Module update observation requires its signed lifecycle fixture")
    version, previous, lifecycle = VERSION_STATES[phase]
    case = Path(ctx.case_dir)
    official = json.loads((case / "official-module-fixture.json").read_text())
    variants = json.loads((case / "official-module" / "variants.json").read_text())
    directory = root / "hello-plugin"
    pointer = json.loads((directory / "active.json").read_text())
    if (pointer["activeVersion"], pointer["previousVersion"]) != (version, previous):
        raise StepError(f"Unexpected module active/previous versions: {pointer}")
    if previous and not isinstance(pointer.get("rollbackUntil"), int):
        raise StepError("Activation did not persist its rollback deadline")
    expected = official if version == official["version"] else variants[version]
    proof = directory / "versions" / version / ".taomni-trust/package.taomni-plugin"
    if hashlib.sha256(proof.read_bytes()).hexdigest() != expected["sha256"]:
        raise StepError("Installed proof does not match the signed version selected by the UI")
    records = invoke(ctx.session, "plugin_list")["value"]
    installed = next((record for record in records if record["manifest"]["slug"] == "hello-plugin"), None)
    if not installed or installed["state"] != lifecycle or installed.get("reason") or installed.get("previousVersion") != previous:
        raise StepError(f"Unexpected active module state: {installed}")
    running = lifecycle == "enabled"
    # Check the OS lease before any oracle command could lazily restart a host.
    lease = writer_lease(root, enabled=running)
    ping = invoke(ctx.session, "plugin_invoke", {"slug": "hello-plugin", "command": "hello/ping"})
    if running:
        if ping.get("value") != {"pluginId": official["id"], "version": version, "enabled": True}:
            raise StepError(f"Real host returned the wrong version: {ping}")
        data = invoke(ctx.session, "plugin_invoke", {"slug": "hello-plugin", "command": "hello/read"})
        if data.get("value") != {"values": ["retained across module versions"]}:
            raise StepError("The signed host could not read the original module data")
    elif ping.get("error", {}).get("code") != -32009:
        raise StepError(f"Disabled module accepted a native command: {ping}")
    if previous and origin.requests.count("/" + official["archive"]) != 1:
        raise StepError("Expected exactly one transfer of the approved signed update")
    if phase == "failed-update":
        rejected = directory / "versions/0.1.1/.taomni-trust/package.taomni-plugin"
        if hashlib.sha256(rejected.read_bytes()).hexdigest() != variants["0.1.1"]["sha256"]:
            raise StepError("Failure did not reach a fully verified replacement package")
    return {"pointer": pointer, "state": lifecycle, "writerLease": lease, "ping": ping}
