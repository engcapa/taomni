"""Observe the fixed certificate, hardened runtime and quarantine of installed code."""

import hashlib
import platform
import re
from pathlib import Path
from tempfile import TemporaryDirectory

from modular_bundle_inventory import digest
from qa_ui_auto.legacy_install import command


def require_hardened_signature(details, certificate, expected):
    match = re.search(r"(?m)^CodeDirectory .*\bflags=0x([0-9a-fA-F]+)\b", details)
    if not match or not int(match[1], 16) & 0x10000 or "Signature=adhoc" in details:
        raise RuntimeError("Expected a fixed-certificate signature with hardened runtime")
    observed = hashlib.sha1(certificate, usedforsecurity=False).hexdigest().upper()
    if observed != expected:
        raise RuntimeError("Installed code has a different leaf certificate than the release identity")
    return {"certificateSha1": observed, "hardenedRuntime": True}


def observe_signature(path, evidence, label, fingerprint):
    command(["codesign", "--verify", "--strict", str(path)], evidence, f"{label}-verify")
    details = command(
        ["codesign", "-d", "--verbose=4", "-r-", str(path)], evidence, f"{label}-signature",
    )
    with TemporaryDirectory(prefix="taomni-g1-leaf-") as directory:
        prefix = Path(directory) / "certificate"
        command(["codesign", "-d", f"--extract-certificates={prefix}", str(path)],
                evidence, f"{label}-extract-certificate")
        leaf = prefix.with_name("certificate0").read_bytes()
    signature = require_hardened_signature(
        (details.stdout + details.stderr).decode("utf-8", errors="replace"), leaf, fingerprint,
    )
    assessment = command(["spctl", "--assess", "--type", "execute", "--verbose=4", str(path)],
                         evidence, f"{label}-gatekeeper", accepted=(0, 3))
    return {**signature, "gatekeeperExitCode": assessment.returncode}


def observe_hardened_host(executable, module, evidence, fingerprint):
    if platform.system() != "Darwin" or not re.fullmatch(r"[0-9A-F]{40}", fingerprint):
        raise RuntimeError("The hardened host check requires macOS and the pinned certificate fingerprint")
    bundle = executable.parents[2]
    if bundle.suffix != ".app":
        raise RuntimeError("Expected an installed macOS app bundle")
    core_signature = observe_signature(bundle, evidence, "g1-core", fingerprint)
    quarantine = "0083;00000000;TaomniInstalledGate;"
    command(["xattr", "-w", "com.apple.quarantine", quarantine, str(module)],
            evidence, "g1-host-set-quarantine")
    observed = command(["xattr", "-p", "com.apple.quarantine", str(module)],
                       evidence, "g1-host-read-quarantine").stdout.decode().strip()
    if observed != quarantine:
        raise RuntimeError("The installed host did not retain its quarantine attribute")
    host_signature = observe_signature(module, evidence, "g1-host", fingerprint)
    return {"core": {**core_signature, "sha256": digest(executable)},
            "host": {**host_signature, "sha256": digest(module), "quarantine": observed},
            "launched": False}
