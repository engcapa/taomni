"""Observe Defender and Authenticode while an installed release runs its MFA host."""

import json
import os
from pathlib import Path

from modular_bundle_inventory import digest
from qa_ui_auto.legacy_install import command


def observe(evidence, label, operation, target=None):
    script = Path(__file__).resolve().parents[4] / "scripts/observe-module-windows-execution.ps1"
    environment = os.environ.copy()
    if target is not None:
        environment["TAOMNI_OBSERVED_MODULE_HOST"] = str(target)
    result = command(
        ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-File", str(script), "-Operation", operation],
        evidence, label, env=environment, timeout=90,
    )
    return json.loads(result.stdout)


def require_defender(state):
    if state["defender"].get("realTimeProtectionEnabled") is not True:
        raise RuntimeError("Defender real-time protection is inactive during installed host verification")


def enable_defender(evidence):
    require_defender(observe(evidence, "windows-defender-setup", "enable-defender"))


def mark_download(host, origin, archive):
    zone = f"[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={origin}/{archive}\r\n"
    Path(f"{host}:Zone.Identifier").write_bytes(zone.encode("utf-8"))
    return zone


def observe_downloaded_host(evidence, phase, host, zone):
    security = observe(evidence, f"g3-defender-{phase}", "security")
    require_defender(security)
    observed = observe(evidence, f"g3-host-{phase}", "host", host)
    if Path(observed["path"]).resolve(strict=True) != host or not observed["authenticodeStatus"]:
        raise RuntimeError("Authenticode did not report the installed host's status")
    if observed["zoneIdentifier"] != zone:
        raise RuntimeError("The installed host did not retain its Internet-zone label")
    return {"security": security, "host": {**observed, "sha256": digest(host)}}
