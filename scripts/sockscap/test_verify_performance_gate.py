#!/usr/bin/env python3
"""Focused fail-closed tests for the Sockscap evidence verifier."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import errno
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest import mock


VERIFIER = runpy.run_path(str(Path(__file__).with_name("verify-performance-gate.py")))
GateFailure = VERIFIER["GateFailure"]
_verify_artifact_gate_receipt = VERIFIER["verify_artifact_gate_receipt"]
verify_core_receipt = VERIFIER["verify_core_receipt"]
verify_native_smoke_receipt = VERIFIER["verify_native_smoke_receipt"]
verify_receipt_artifact_file = VERIFIER["verify_receipt_artifact_file"]
verify_receipt_artifact_directory = VERIFIER["verify_receipt_artifact_directory"]
directory_tree_sha256 = VERIFIER["directory_tree_sha256"]
windows_release_policy = VERIFIER["windows_release_policy"]
macos_release_policy = VERIFIER["macos_release_policy"]
linux_release_policy = VERIFIER["linux_release_policy"]
verify_linux_bound_manifests = VERIFIER["verify_linux_bound_manifests"]
verify_linux_install_provenance = VERIFIER["verify_linux_install_provenance"]
verify_linux_receipt_artifact_file = VERIFIER["verify_linux_receipt_artifact_file"]
verify_platform_manifest = VERIFIER["verify_platform_manifest"]
lint_platform_template = VERIFIER["lint_platform_template"]
LINUX_INSTALL_CHECKS = VERIFIER["LINUX_INSTALL_CHECKS"]

LINUX_FINGERPRINT = "0123456789ABCDEF0123456789ABCDEF01234567"
LINUX_RPM_FINGERPRINT = "89ABCDEF0123456789ABCDEF0123456789ABCDEF"


def windows_test_release_policy() -> tuple[dict, str]:
    policy, _ = windows_release_policy()
    policy = deepcopy(policy)
    policy["firstParty"] = {
        "configurationState": "configured",
        "publisherSubject": "CN=Taomni Release",
        "signerCertificateSha256": "9" * 64,
    }
    encoded = json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()
    return policy, hashlib.sha256(encoded).hexdigest()


def macos_test_release_policy() -> tuple[dict, str]:
    policy, _ = macos_release_policy()
    policy = deepcopy(policy)
    policy.update(
        configurationState="configured",
        teamIdentifier="ABCDE12345",
        signerCertificateSha256="8" * 64,
        requiredArchitectures=["arm64"],
    )
    encoded = json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()
    return policy, hashlib.sha256(encoded).hexdigest()


def linux_test_release_policy(base: Path | None = None) -> tuple[dict, str]:
    policy, _ = linux_release_policy()
    policy = deepcopy(policy)
    policy.update(
        configurationState="configured",
        packageDependencyContractState="configured",
        supportedArchitectures=["x86_64"],
    )
    policy["packageSignatures"]["deb"]["signerFingerprint"] = LINUX_FINGERPRINT
    policy["packageSignatures"]["rpm"]["signerFingerprint"] = LINUX_RPM_FINGERPRINT
    if base is not None:
        installed = base / "installed"
        test_paths = {
            "application": installed / "usr/bin/taomni",
            "helper": installed / "usr/libexec/taomni/sockscap-helper",
            "helperPolicy": installed / "etc/taomni/sockscap-helper-policy.json",
            "polkitAction": installed
            / "usr/share/polkit-1/actions/com.taomni.sockscap.policy",
        }
        for role, path in test_paths.items():
            policy["installedArtifacts"][role]["path"] = str(path)
            policy["installedArtifacts"][role]["uid"] = os.getuid()
            policy["installedArtifacts"][role]["gid"] = os.getgid()
        policy["polkit"]["execPath"] = str(test_paths["helper"])
    encoded = json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()
    return policy, hashlib.sha256(encoded).hexdigest()


def verify_artifact_gate_receipt(*args, **kwargs):
    """Exercise receipt contracts without requiring fixture files at fake OS paths."""
    kwargs.setdefault("verify_artifact_files", False)
    if kwargs.get("platform") == "windows":
        kwargs.setdefault("windows_policy_override", windows_test_release_policy())
    if kwargs.get("platform") == "macos":
        kwargs.setdefault("macos_policy_override", macos_test_release_policy())
    if kwargs.get("platform") == "linux":
        kwargs.setdefault("linux_policy_override", linux_test_release_policy())
    return _verify_artifact_gate_receipt(*args, **kwargs)


def core_receipt(*, mode: str = "quick", duration_seconds: int = 0) -> dict:
    long_active = mode == "soak"
    return {
        "schemaVersion": 1,
        "gateKind": "sockscap_core_performance",
        "evidenceClass": "synthetic_core_no_host_capture",
        "releaseEligible": False,
        "mode": mode,
        "passed": True,
        "optimizedBuild": True,
        "platform": "linux",
        "architecture": "x86_64",
        "gitCommit": "a" * 40,
        "startedAtUnix": 1_700_000_000,
        "finishedAtUnix": 1_700_000_000 + duration_seconds,
        "observedDurationMillis": duration_seconds * 1_000,
        "requestedSoakDurationSeconds": duration_seconds if long_active else None,
        "ruleMatch": {
            "ruleCount": 10_000,
            "sampleCount": 20_000,
            "compileMillis": 10,
            "medianNanos": 1_000,
            "p99Nanos": 2_000,
            "p99ThresholdNanos": 100_000,
            "matchedAllSamples": True,
            "passed": True,
        },
        "dashboard": {
            "generatedEvents": 1_000,
            "retainedCapacity": 256,
            "returnedSamples": 200,
            "droppedSamples": 744,
            "queryP99Nanos": 10_000,
            "bounded": True,
            "passed": True,
        },
        "lifecycle": {
            "requiredStartStopCycles": 100,
            "completedStartStopCycles": 100,
            "longActiveSessionCompleted": long_active,
            "heartbeatCount": duration_seconds // 10 if long_active else 0,
            "cycleMedianNanos": 500_000,
            "cycleP99Nanos": 1_000_000,
            "finalJournalPhase": "clean",
            "cleanupRequired": False,
            "adapterInstallCalls": 101,
            "adapterStopCalls": 101,
            "adapterRecoverCalls": 0,
            "passed": True,
        },
        "resources": {
            "sampleCount": max(2, duration_seconds // 2),
            "rssStartBytes": 8_000_000,
            "rssEndBytes": 8_001_000,
            "rssPeakBytes": 8_002_000,
            "rssEndGrowthBytes": 1_000,
            "rssPeakGrowthBytes": 2_000,
            "maxRssEndGrowthBytes": 32 * 1024 * 1024,
            "maxRssPeakGrowthBytes": 64 * 1024 * 1024,
            "openFileMeasurementSupported": True,
            "openFilesStart": 12,
            "openFilesEnd": 12,
            "openFilesPeak": 13,
            "openFileGrowth": 0,
            "maxOpenFileGrowth": 4,
            "passed": True,
        },
        "limitations": ["synthetic"],
    }


def native_receipt() -> dict:
    return {
        "schemaVersion": 1,
        "gateKind": "sockscap_native_capture_smoke",
        "evidenceClass": "real_host_capture",
        "releaseEligible": True,
        "mode": "native",
        "result": "PASS",
        "gitCommit": "a" * 40,
        "platform": "linux",
        "architecture": "x86_64",
        "captureProvider": "cgroup_v2_nft_tun",
        "buildId": "linux-x86_64-test",
        "artifactGateSha256": "a" * 64,
        "artifacts": {
            "applicationSha256": "b" * 64,
            "privilegedComponentSha256": "c" * 64,
            "providerSha256": "d" * 64,
        },
        "totals": {"total": 1, "passed": 1, "failed": 0, "skipped": 0},
        "cases": [
            {
                "id": "TC-SOCKSCAP-native-capture-smoke",
                "status": "passed",
                "modes": ["native"],
            }
        ],
        "captureMatrix": {
            "globalIpv4Tcp": True,
            "globalIpv6Tcp": True,
            "applicationGroupIpv4Tcp": True,
            "runtimePidIpv4Tcp": True,
            "dnsCaptured": True,
            "udpPolicyEnforced": True,
            "hardBypassVerified": True,
            "cleanupResidueZero": True,
        },
    }


def windows_artifact_receipt() -> dict:
    policy, policy_sha256 = windows_test_release_policy()
    wintun = policy["wintun"]
    windivert = policy["windivert"]
    return {
        "gateSchemaVersion": 1,
        "gateKind": "sockscap_windows_artifact",
        "platform": "windows",
        "mode": "release",
        "result": "PASS",
        "architecture": "x86_64",
        "gitCommit": "a" * 40,
        "buildId": "windows-x86_64-test",
        "applicationCaptureProvider": "windivert",
        "artifactManifestSha256": "1" * 64,
        "releasePolicySchemaVersion": policy["schemaVersion"],
        "releasePolicySha256": policy_sha256,
        "application": "taomni.exe",
        "applicationSha256": "2" * 64,
        "applicationSignerSubject": policy["firstParty"]["publisherSubject"],
        "applicationSignerCertificateSha256": policy["firstParty"][
            "signerCertificateSha256"
        ],
        "helper": "helper.exe",
        "helperSha256": "3" * 64,
        "helperSignerSubject": policy["firstParty"]["publisherSubject"],
        "helperSignerCertificateSha256": policy["firstParty"][
            "signerCertificateSha256"
        ],
        "wintun": {
            "version": wintun["version"],
            "package": "wintun-0.14.1.zip",
            "packageUrl": wintun["packageUrl"],
            "packageSha256": wintun["packageSha256"],
            "userMode": "wintun.dll",
            "userModeSha256": wintun["userModeSha256"],
            "license": "wintun-LICENSE.txt",
            "licenseSha256": wintun["licenseSha256"],
            "signerSubject": "CN=WireGuard LLC",
            "signerCertificateSha256": wintun["signerCertificateSha256"],
        },
        "windivert": {
            "version": windivert["version"],
            "variant": windivert["variant"],
            "package": "WinDivert-2.2.2-A.zip",
            "packageUrl": windivert["packageUrl"],
            "packageSha256": windivert["packageSha256"],
            "userMode": "WinDivert.dll",
            "userModeSha256": windivert["userModeSha256"],
            "driver": "WinDivert64.sys",
            "driverSha256": windivert["driverSha256"],
            "license": "LICENSE",
            "licenseSha256": windivert["licenseSha256"],
            "userModeSignatureMode": windivert["userModeSignatureMode"],
            "userModeSignerSubject": windivert["userModeSignerSubject"],
            "driverSignerSubject": windivert["driverSignerSubject"],
            "driverSignerCertificateSha256": windivert["driverSignerCertificateSha256"],
        },
    }


def macos_artifact_receipt() -> dict:
    policy, policy_sha256 = macos_test_release_policy()
    return {
        "gateSchemaVersion": 1,
        "gateKind": "sockscap_macos_artifact",
        "platform": "macos",
        "mode": "release",
        "result": "PASS",
        "gitCommit": "a" * 40,
        "buildId": "macos-arm64-test",
        "releasePolicySchemaVersion": policy["schemaVersion"],
        "releasePolicySha256": policy_sha256,
        "app": "/staged/Taomni.app",
        "provider": "/staged/Taomni.systemextension",
        "appExecutable": "/staged/Taomni.app/Contents/MacOS/taomni",
        "providerExecutable": "/staged/Taomni.systemextension/Contents/MacOS/provider",
        "appBundleIdentifier": policy["appBundleIdentifier"],
        "providerBundleIdentifier": policy["providerBundleIdentifier"],
        "candidateBundleDigestAlgorithm": policy["candidateBundleDigestAlgorithm"],
        "candidateBundleSha256": "0" * 64,
        "appExecutableSha256": "1" * 64,
        "providerExecutableSha256": "2" * 64,
        "appSignerCertificateSha256": policy["signerCertificateSha256"],
        "providerSignerCertificateSha256": policy["signerCertificateSha256"],
        "appEntitlementsSha256": "3" * 64,
        "providerEntitlementsSha256": "4" * 64,
        "appProvisioningProfileSha256": "5" * 64,
        "providerProvisioningProfileSha256": "6" * 64,
        "teamIdentifier": policy["teamIdentifier"],
        "architectures": ["arm64"],
        "providerArchitectures": ["arm64"],
        "provisioningProfilesVerified": True,
        "notarizationTicketVerified": True,
    }


def linux_artifact_receipt(
    *, kind: str = "deb", policy_override: tuple[dict, str] | None = None
) -> dict:
    policy, policy_sha256 = policy_override or linux_test_release_policy()
    package_path = f"/release/taomni-1.2.3.{kind}"
    package_sha256 = "4" * 64
    signature_path = f"{package_path}.asc" if kind == "deb" else package_path
    signature_sha256 = "5" * 64 if kind == "deb" else package_sha256
    installed = policy["installedArtifacts"]
    return {
        "gateSchemaVersion": 1,
        "gateKind": "sockscap_linux_artifact",
        "platform": "linux",
        "mode": "release",
        "result": "PASS",
        "architecture": "x86_64",
        "captureProvider": "cgroup_v2_nft_tun",
        "capturePackageKinds": ["deb", "rpm"],
        "appImageCaptureDisabled": True,
        "verificationScope": "same_host_installed_fixed_paths",
        "externalEvidenceRequired": ["native_install_lab_provenance"],
        "gitCommit": "a" * 40,
        "buildId": "linux-x86_64-test",
        "releasePolicySchemaVersion": 1,
        "releasePolicySha256": policy_sha256,
        "artifactManifestPath": "/release/release-manifest.json",
        "artifactManifestSha256": "1" * 64,
        "packageKind": kind,
        "packageVersion": "1.2.3-1",
        "packagePath": package_path,
        "packageSha256": package_sha256,
        "packageSignatureScheme": policy["packageSignatures"][kind]["scheme"],
        "packageSignerFingerprint": policy["packageSignatures"][kind][
            "signerFingerprint"
        ],
        "signaturePath": signature_path,
        "signatureSha256": signature_sha256,
        "packageSigningPublicKey": "/release/linux-release-signing-key.asc",
        "packageSigningPublicKeySha256": "6" * 64,
        "packageDependencies": {
            "required": list(policy["packageDependencies"][kind]),
            "packageMetadata": list(policy["packageDependencies"][kind]),
        },
        "packageManifestPath": "/release/linux-package-manifest.json",
        "packageManifestSha256": "7" * 64,
        "packageScriptsSha256": "8" * 64,
        "application": installed["application"]["path"],
        "applicationSha256": "9" * 64,
        "helper": installed["helper"]["path"],
        "helperSha256": "a" * 64,
        "helperPolicy": installed["helperPolicy"]["path"],
        "helperPolicySha256": "b" * 64,
        "polkitAction": installed["polkitAction"]["path"],
        "polkitActionSha256": "c" * 64,
        "packageSignatureVerified": True,
        "packagePayloadVerified": True,
        "packageDependenciesVerified": True,
        "packageScriptsVerified": True,
        "helperOwnershipVerified": True,
        "helperPolicyVerified": True,
        "polkitActionVerified": True,
    }


def linux_package_scripts(policy: dict, kind: str) -> dict:
    phases = {}
    for phase, logical_name in policy["packageScripts"]["mappings"][kind].items():
        definition = policy["packageScripts"]["definitions"][logical_name]
        phases[phase] = {
            "logicalName": logical_name,
            "rawSha256": definition["rawSha256"][kind],
            "normalizedSha256": definition["normalizedSha256"],
            "size": 32,
            "interpreter": policy["packageScripts"]["interpreter"],
        }
    return {
        "normalization": policy["packageScripts"]["normalization"],
        "phases": phases,
    }


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_linux_artifact_fixture(
    root: Path, kind: str = "deb"
) -> tuple[Path, dict, tuple[dict, str]]:
    policy_override = linux_test_release_policy(root)
    policy, policy_sha256 = policy_override
    receipt = linux_artifact_receipt(kind=kind, policy_override=policy_override)
    release = root / "release"
    release.mkdir(parents=True)

    package = release / f"taomni-1.2.3.{kind}"
    package.write_bytes(f"{kind}-package".encode())
    key = release / "linux-release-signing-key.asc"
    key.write_bytes(b"test-public-key")
    signature = Path(f"{package}.asc") if kind == "deb" else package
    if kind == "deb":
        signature.write_bytes(b"test-detached-signature")

    installed_hashes = {
        "application": hashlib.sha256(b"application").hexdigest(),
        "helper": hashlib.sha256(b"helper").hexdigest(),
        "helperPolicy": hashlib.sha256(b"helper-policy").hexdigest(),
        "polkitAction": hashlib.sha256(b"polkit-action").hexdigest(),
    }
    installed_contents = {
        "application": b"application",
        "helper": b"helper",
        "helperPolicy": b"helper-policy",
        "polkitAction": b"polkit-action",
    }
    for role, contract in policy["installedArtifacts"].items():
        path = Path(contract["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(installed_contents[role])
        path.chmod(int(contract["mode"], 8))

    package_scripts = linux_package_scripts(policy, kind)
    package_scripts_sha256 = hashlib.sha256(
        json.dumps(package_scripts, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    entries = []
    for role, contract in policy["installedArtifacts"].items():
        entries.append(
            {
                "path": contract["path"],
                "type": "file",
                "mode": contract["mode"],
                "owner": "root",
                "group": "root",
                "size": len(installed_contents[role]),
                "sha256": installed_hashes[role],
                "linkTarget": "",
            }
        )
    for payload_path in (
        *policy["packagePayload"]["desktopFiles"],
        *policy["packagePayload"]["iconFiles"],
    ):
        entries.append(
            {
                "path": payload_path,
                "type": "file",
                "mode": "0644",
                "owner": "root",
                "group": "root",
                "size": 2,
                "sha256": hashlib.sha256(payload_path.encode()).hexdigest(),
                "linkTarget": "",
            }
        )
    package_manifest = {
        "schemaVersion": 1,
        "manifestKind": "sockscap_linux_package",
        "platform": "linux",
        "architecture": "x86_64",
        "captureProvider": "cgroup_v2_nft_tun",
        "packageKind": kind,
        "packageName": "taomni",
        "packageVersion": "1.2.3-1",
        "packageSha256": sha256_file(package),
        "signatureScheme": policy["packageSignatures"][kind]["scheme"],
        "signerFingerprint": policy["packageSignatures"][kind]["signerFingerprint"],
        "signatureSha256": sha256_file(signature),
        "signingPublicKeySha256": sha256_file(key),
        "packageDependencies": deepcopy(receipt["packageDependencies"]),
        "entries": entries,
        "packageScripts": package_scripts,
        "packageScriptsSha256": package_scripts_sha256,
        "verificationScope": "same_host_installed_fixed_paths",
        "externalEvidenceRequired": ["native_install_lab_provenance"],
    }
    package_manifest_path = release / "linux-package-manifest.json"
    package_manifest_path.write_text(json.dumps(package_manifest), encoding="utf-8")

    artifact_manifest = {
        "schemaVersion": 1,
        "captureReleaseEnabled": True,
        "gitCommit": "a" * 40,
        "buildId": "linux-x86_64-test",
        "platform": "linux",
        "architecture": "x86_64",
        "captureProvider": "cgroup_v2_nft_tun",
        "package": {
            "kind": kind,
            "path": package.name,
            "sha256": sha256_file(package),
            "signature": {
                "scheme": policy["packageSignatures"][kind]["scheme"],
                "path": signature.name if kind == "deb" else "",
                "sha256": sha256_file(signature) if kind == "deb" else "",
                "publicKeyPath": key.name,
                "publicKeySha256": sha256_file(key),
            },
        },
        "installedArtifacts": {
            role: contract["path"]
            for role, contract in policy["installedArtifacts"].items()
        },
        "packageManifestOutput": package_manifest_path.name,
    }
    artifact_manifest_path = release / "release-manifest.json"
    artifact_manifest_path.write_text(json.dumps(artifact_manifest), encoding="utf-8")

    receipt.update(
        releasePolicySha256=policy_sha256,
        artifactManifestPath=str(artifact_manifest_path),
        artifactManifestSha256=sha256_file(artifact_manifest_path),
        packagePath=str(package),
        packageSha256=sha256_file(package),
        signaturePath=str(signature),
        signatureSha256=sha256_file(signature),
        packageSigningPublicKey=str(key),
        packageSigningPublicKeySha256=sha256_file(key),
        packageManifestPath=str(package_manifest_path),
        packageManifestSha256=sha256_file(package_manifest_path),
        packageScriptsSha256=package_scripts_sha256,
        **{f"{role}Sha256": installed_hashes[role] for role in installed_hashes},
    )
    receipt_path = release / "artifact-receipt.json"
    receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
    return receipt_path, receipt, policy_override


def linux_install_provenance(
    root: Path, artifact_gate_path: Path, artifact_receipt: dict
) -> tuple[Path, dict, list[Path]]:
    raw_files = {
        "package_manager_transcript": root / "package-manager.log",
        "package_database_snapshot": root / "package-database.json",
        "root_policy_audit": root / "root-policy.json",
        "residue_audit": root / "residue-audit.json",
        "previous_package_signature": root / "previous-package-signature.log",
    }
    for kind, raw_path in raw_files.items():
        raw_path.write_text(f"external placeholder {kind}\n", encoding="utf-8")
    kind = artifact_receipt["packageKind"]
    receipt = {
        "schemaVersion": 1,
        "gateKind": "sockscap_linux_install_provenance",
        "evidenceClass": "real_root_package_manager_lab",
        "verificationState": "external_attestation_unconfigured",
        "releaseEligible": False,
        "result": "BLOCKED",
        "platform": "linux",
        "architecture": "x86_64",
        "captureProvider": "cgroup_v2_nft_tun",
        "gitCommit": "a" * 40,
        "buildId": artifact_receipt["buildId"],
        "artifactGateSha256": sha256_file(artifact_gate_path),
        "lab": {
            "environmentKind": "disposable_real_host_or_vm",
            "privilegeMode": "root",
            "packageManager": "apt_dpkg" if kind == "deb" else "dnf_rpm",
            "packageDatabase": "dpkg" if kind == "deb" else "rpm",
            "synthetic": False,
        },
        "package": {
            "kind": kind,
            "name": "taomni",
            "version": artifact_receipt["packageVersion"],
            "sha256": artifact_receipt["packageSha256"],
            "signatureScheme": artifact_receipt["packageSignatureScheme"],
            "signerFingerprint": artifact_receipt["packageSignerFingerprint"],
        },
        "previousSignedPackage": {
            "kind": kind,
            "name": "taomni",
            "version": "1.2.2-1",
            "sha256": "d" * 64,
            "signatureScheme": artifact_receipt["packageSignatureScheme"],
            "signerFingerprint": artifact_receipt["packageSignerFingerprint"],
            "signatureVerified": True,
        },
        "checks": {key: "PASS" for key in LINUX_INSTALL_CHECKS},
        "rawEvidence": [
            {
                "kind": kind,
                "name": kind.replace("_", "-"),
                "path": raw_path.name,
                "sha256": sha256_file(raw_path),
            }
            for kind, raw_path in raw_files.items()
        ],
    }
    path = root / "linux-install-provenance.json"
    path.write_text(json.dumps(receipt), encoding="utf-8")
    return path, receipt, list(raw_files.values())


def rewrite_package_manifest(receipt: dict, mutate) -> None:
    path = Path(receipt["packageManifestPath"])
    manifest = json.loads(path.read_text(encoding="utf-8"))
    mutate(manifest)
    if "packageScripts" in manifest:
        scripts_hash = hashlib.sha256(
            json.dumps(
                manifest["packageScripts"],
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        manifest["packageScriptsSha256"] = scripts_hash
        receipt["packageScriptsSha256"] = scripts_hash
    path.write_text(json.dumps(manifest), encoding="utf-8")
    receipt["packageManifestSha256"] = sha256_file(path)


class VerifierTests(unittest.TestCase):
    def write_json(self, directory: str, name: str, value: dict) -> Path:
        path = Path(directory, name)
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def assert_failure_code(self, expected: str, callback) -> None:
        with self.assertRaises(GateFailure) as raised:
            callback()
        self.assertEqual(raised.exception.code, expected)

    def test_valid_quick_and_long_soak_receipts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            quick = self.write_json(directory, "quick.json", core_receipt())
            soak = self.write_json(
                directory,
                "soak.json",
                core_receipt(mode="soak", duration_seconds=86_400),
            )
            verify_core_receipt(
                quick,
                expected_commit="a" * 40,
                expected_platform="linux",
                expected_architecture="x86_64",
            )
            verify_core_receipt(soak, min_duration_seconds=86_400)

    def test_windows_template_freezes_reviewed_windivert_release(self) -> None:
        template_path = (
            Path(__file__).parents[2]
            / "src-tauri/platform/sockscap/windows/release-manifest.template.json"
        )
        template = json.loads(template_path.read_text(encoding="utf-8"))
        self.assertEqual(template["schemaVersion"], 2)
        self.assertFalse(template["captureReleaseEnabled"])
        self.assertEqual(template["architecture"], "x86_64")
        self.assertEqual(template["applicationCaptureProvider"], "windivert")
        provider = template["artifacts"]["applicationProvider"]
        wintun = template["artifacts"]["wintun"]
        policy, _ = windows_release_policy()
        self.assertEqual(wintun["version"], "0.14.1")
        self.assertEqual(
            wintun["sha256"],
            "e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce",
        )
        self.assertEqual(provider["kind"], "windivert")
        self.assertEqual(provider["version"], "2.2.2")
        self.assertEqual(provider["variant"], "A")
        self.assertEqual(provider["userModeSignatureMode"], "unsigned_official")
        self.assertEqual(provider["userModeSignerSubject"], "")
        self.assertNotIn("catalogPath", provider)
        self.assertNotIn("infPath", provider)
        self.assertEqual(
            provider["packageSha256"],
            "63cb41763bb4b20f600b6de04e991a9c2be73279e317d4d82f237b150c5f3f15",
        )
        self.assertEqual(
            provider["userModeSha256"],
            "c1e060ee19444a259b2162f8af0f3fe8c4428a1c6f694dce20de194ac8d7d9a2",
        )
        self.assertEqual(
            provider["driverSha256"],
            "8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2",
        )
        self.assertEqual(
            provider["licenseSha256"],
            "14a0cb5214d536e4fdae6aa3f5696f981eeda106cd026e9794bba489ee79d628",
        )
        self.assertTrue(provider["driverSignerSubject"].startswith("CN="))
        self.assertEqual(template["architecture"], policy["architecture"])
        self.assertEqual(
            template["expectedPublisher"], policy["firstParty"]["publisherSubject"]
        )
        self.assertEqual(policy["firstParty"]["configurationState"], "unconfigured")
        self.assertEqual(
            template["applicationCaptureProvider"],
            policy["applicationCaptureProvider"],
        )
        self.assertEqual(wintun["version"], policy["wintun"]["version"])
        self.assertEqual(wintun["packageSha256"], policy["wintun"]["packageSha256"])
        self.assertEqual(wintun["sha256"], policy["wintun"]["userModeSha256"])
        self.assertEqual(wintun["licenseSha256"], policy["wintun"]["licenseSha256"])
        for field in (
            "version",
            "variant",
            "packageUrl",
            "packageSha256",
            "userModeSha256",
            "driverSha256",
            "licenseSha256",
            "userModeSignatureMode",
            "userModeSignerSubject",
            "driverSignerSubject",
        ):
            self.assertEqual(provider[field], policy["windivert"][field])

    def test_core_receipt_rejects_release_claim_and_inconsistent_counts(self) -> None:
        mutations = (
            (
                "CORE_RELEASE_CLAIM_INVALID",
                lambda value: value.update(releaseEligible=True),
            ),
            (
                "CORE_DASHBOARD_INVALID",
                lambda value: value["dashboard"].update(returnedSamples=0),
            ),
            (
                "CORE_LIFECYCLE_CALLS_INVALID",
                lambda value: value["lifecycle"].update(adapterStopCalls=0),
            ),
            (
                "CORE_RSS_INVALID",
                lambda value: value["resources"].update(rssEndGrowthBytes=0),
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            for index, (expected, mutate) in enumerate(mutations):
                receipt = deepcopy(core_receipt())
                mutate(receipt)
                path = self.write_json(directory, f"bad-{index}.json", receipt)
                self.assert_failure_code(
                    expected, lambda path=path: verify_core_receipt(path)
                )

    def test_short_soak_cannot_satisfy_release_duration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(
                directory,
                "short.json",
                core_receipt(mode="soak", duration_seconds=3),
            )
            self.assert_failure_code(
                "CORE_SOAK_TOO_SHORT",
                lambda: verify_core_receipt(path, min_duration_seconds=86_400),
            )

    def test_artifact_receipt_rejects_lint_output(self) -> None:
        receipt = windows_artifact_receipt()
        receipt["mode"] = "lint"
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "artifact.json", receipt)
            self.assert_failure_code(
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                lambda: verify_artifact_gate_receipt(
                    path,
                    platform="windows",
                    architecture="x86_64",
                    provider="windivert",
                ),
            )

    def test_windows_artifact_receipt_requires_pinned_windivert(self) -> None:
        receipt = windows_artifact_receipt()
        with tempfile.TemporaryDirectory() as directory:
            good = self.write_json(directory, "artifact.json", receipt)
            verify_artifact_gate_receipt(
                good,
                platform="windows",
                architecture="x86_64",
                provider="windivert",
            )

            bad_provider = self.write_json(directory, "wfp.json", receipt)
            self.assert_failure_code(
                "PLATFORM_PROVIDER_INVALID",
                lambda: verify_artifact_gate_receipt(
                    bad_provider,
                    platform="windows",
                    architecture="x86_64",
                    provider="wfp",
                ),
            )

            bad_arch = self.write_json(directory, "arm64.json", receipt)
            self.assert_failure_code(
                "PLATFORM_ARCH_UNSUPPORTED",
                lambda: verify_artifact_gate_receipt(
                    bad_arch,
                    platform="windows",
                    architecture="aarch64",
                    provider="windivert",
                ),
            )

            missing_driver_signer = deepcopy(receipt)
            missing_driver_signer["windivert"]["driverSignerSubject"] = ""
            bad_signer = self.write_json(
                directory, "missing-driver-signer.json", missing_driver_signer
            )
            self.assert_failure_code(
                "WINDOWS_RELEASE_POLICY_MISMATCH",
                lambda: verify_artifact_gate_receipt(
                    bad_signer,
                    platform="windows",
                    architecture="x86_64",
                    provider="windivert",
                ),
            )

            committed_policy, committed_policy_sha256 = windows_release_policy()
            unconfigured = deepcopy(receipt)
            unconfigured["releasePolicySha256"] = committed_policy_sha256
            unconfigured["applicationSignerSubject"] = committed_policy["firstParty"][
                "publisherSubject"
            ]
            unconfigured["helperSignerSubject"] = committed_policy["firstParty"][
                "publisherSubject"
            ]
            unconfigured["applicationSignerCertificateSha256"] = committed_policy[
                "firstParty"
            ]["signerCertificateSha256"]
            unconfigured["helperSignerCertificateSha256"] = committed_policy[
                "firstParty"
            ]["signerCertificateSha256"]
            unconfigured_path = self.write_json(
                directory, "unconfigured-publisher.json", unconfigured
            )
            self.assert_failure_code(
                "WINDOWS_FIRST_PARTY_POLICY_UNCONFIGURED",
                lambda: _verify_artifact_gate_receipt(
                    unconfigured_path,
                    platform="windows",
                    architecture="x86_64",
                    provider="windivert",
                    verify_artifact_files=False,
                ),
            )

            false_dll_signer = deepcopy(receipt)
            false_dll_signer["windivert"]["userModeSignerSubject"] = "CN=Claimed"
            bad_dll_signer = self.write_json(
                directory, "false-dll-signer.json", false_dll_signer
            )
            self.assert_failure_code(
                "WINDOWS_RELEASE_POLICY_MISMATCH",
                lambda: verify_artifact_gate_receipt(
                    bad_dll_signer,
                    platform="windows",
                    architecture="x86_64",
                    provider="windivert",
                ),
            )

            bad_wintun_url = deepcopy(receipt)
            bad_wintun_url["wintun"]["packageUrl"] = (
                "https://example.invalid/wintun.zip"
            )
            bad_wintun = self.write_json(
                directory, "bad-wintun-url.json", bad_wintun_url
            )
            self.assert_failure_code(
                "WINDOWS_RELEASE_POLICY_MISMATCH",
                lambda: verify_artifact_gate_receipt(
                    bad_wintun,
                    platform="windows",
                    architecture="x86_64",
                    provider="windivert",
                ),
            )

            unpinned_version = deepcopy(receipt)
            unpinned_version["windivert"]["version"] = "9.9.9"
            bad_version = self.write_json(
                directory, "unpinned-version.json", unpinned_version
            )
            self.assert_failure_code(
                "WINDOWS_RELEASE_POLICY_MISMATCH",
                lambda: verify_artifact_gate_receipt(
                    bad_version,
                    platform="windows",
                    architecture="x86_64",
                    provider="windivert",
                ),
            )

            unpinned_hash = deepcopy(receipt)
            unpinned_hash["wintun"]["packageSha256"] = "f" * 64
            bad_hash = self.write_json(directory, "unpinned-hash.json", unpinned_hash)
            self.assert_failure_code(
                "WINDOWS_RELEASE_POLICY_MISMATCH",
                lambda: verify_artifact_gate_receipt(
                    bad_hash,
                    platform="windows",
                    architecture="x86_64",
                    provider="windivert",
                ),
            )

            wrong_policy = deepcopy(receipt)
            wrong_policy["releasePolicySha256"] = "0" * 64
            bad_policy = self.write_json(directory, "wrong-policy.json", wrong_policy)
            self.assert_failure_code(
                "WINDOWS_RELEASE_POLICY_MISMATCH",
                lambda: verify_artifact_gate_receipt(
                    bad_policy,
                    platform="windows",
                    architecture="x86_64",
                    provider="windivert",
                ),
            )

    def test_native_smoke_requires_real_native_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            good = self.write_json(directory, "native.json", native_receipt())
            expected_artifacts = native_receipt()["artifacts"]
            verify_native_smoke_receipt(
                good, expected_artifact_hashes=expected_artifacts
            )
            bad_receipt = native_receipt()
            bad_receipt["mode"] = "browser"
            bad = self.write_json(directory, "browser.json", bad_receipt)
            self.assert_failure_code(
                "PLATFORM_NATIVE_SMOKE_INVALID",
                lambda: verify_native_smoke_receipt(bad),
            )
            window_only = native_receipt()
            window_only["cases"][0]["id"] = "TC-SOCKSCAP-native-window-smoke"
            window = self.write_json(directory, "window-only.json", window_only)
            self.assert_failure_code(
                "PLATFORM_NATIVE_SMOKE_FAILED",
                lambda: verify_native_smoke_receipt(window),
            )

            wrong_binary = native_receipt()
            wrong_binary["artifacts"]["applicationSha256"] = "e" * 64
            wrong_binary_path = self.write_json(
                directory, "wrong-binary.json", wrong_binary
            )
            self.assert_failure_code(
                "PLATFORM_NATIVE_SMOKE_INVALID",
                lambda: verify_native_smoke_receipt(
                    wrong_binary_path,
                    expected_artifact_hashes=expected_artifacts,
                ),
            )

            wrong_build = native_receipt()
            wrong_build["buildId"] = "LINUX-x86_64-test"
            wrong_build_path = self.write_json(
                directory, "wrong-build.json", wrong_build
            )
            self.assert_failure_code(
                "PLATFORM_NATIVE_SMOKE_INVALID",
                lambda: verify_native_smoke_receipt(
                    wrong_build_path,
                    expected_build_id="linux-x86_64-test",
                ),
            )

            macos_native = native_receipt()
            macos_native.update(
                platform="macos",
                architecture="aarch64",
                captureProvider="network_extension_transparent_proxy",
                buildId="macos-arm64-test",
            )
            macos_native["artifacts"]["candidateBundleSha256"] = "f" * 64
            macos_native_path = self.write_json(
                directory, "macos-native.json", macos_native
            )
            verify_native_smoke_receipt(
                macos_native_path,
                expected_artifact_hashes=macos_native["artifacts"],
            )
            wrong_bundle_hashes = deepcopy(macos_native["artifacts"])
            wrong_bundle_hashes["candidateBundleSha256"] = "0" * 64
            self.assert_failure_code(
                "PLATFORM_NATIVE_SMOKE_INVALID",
                lambda: verify_native_smoke_receipt(
                    macos_native_path,
                    expected_artifact_hashes=wrong_bundle_hashes,
                ),
            )

            duplicate_cases = native_receipt()
            duplicate_cases["totals"] = {
                "total": 2,
                "passed": 2,
                "failed": 0,
                "skipped": 0,
            }
            duplicate_cases["cases"].append(deepcopy(duplicate_cases["cases"][0]))
            duplicate_path = self.write_json(
                directory, "duplicate-case.json", duplicate_cases
            )
            self.assert_failure_code(
                "PLATFORM_NATIVE_SMOKE_INVALID",
                lambda: verify_native_smoke_receipt(duplicate_path),
            )

    def test_macos_artifact_requires_provider_arch_and_release_proofs(self) -> None:
        receipt = macos_artifact_receipt()
        with tempfile.TemporaryDirectory() as directory:
            good = self.write_json(directory, "macos.json", receipt)
            verify_artifact_gate_receipt(
                good,
                platform="macos",
                architecture="aarch64",
                provider="network_extension_transparent_proxy",
                expected_commit="a" * 40,
            )

            missing_provider_arch = deepcopy(receipt)
            missing_provider_arch["providerArchitectures"] = ["x86_64"]
            bad_arch = self.write_json(
                directory, "macos-provider-arch.json", missing_provider_arch
            )
            self.assert_failure_code(
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                lambda: verify_artifact_gate_receipt(
                    bad_arch,
                    platform="macos",
                    architecture="aarch64",
                    provider="network_extension_transparent_proxy",
                    expected_commit="a" * 40,
                ),
            )

            wrong_signer = deepcopy(receipt)
            wrong_signer["providerSignerCertificateSha256"] = "7" * 64
            bad_signer = self.write_json(directory, "macos-signer.json", wrong_signer)
            self.assert_failure_code(
                "MACOS_RELEASE_POLICY_MISMATCH",
                lambda: verify_artifact_gate_receipt(
                    bad_signer,
                    platform="macos",
                    architecture="aarch64",
                    provider="network_extension_transparent_proxy",
                    expected_commit="a" * 40,
                ),
            )

            committed_policy, committed_policy_sha256 = macos_release_policy()
            unconfigured = deepcopy(receipt)
            unconfigured["releasePolicySha256"] = committed_policy_sha256
            unconfigured_path = self.write_json(
                directory, "macos-unconfigured.json", unconfigured
            )
            self.assert_failure_code(
                "MACOS_FIRST_PARTY_POLICY_UNCONFIGURED",
                lambda: _verify_artifact_gate_receipt(
                    unconfigured_path,
                    platform="macos",
                    architecture="aarch64",
                    provider="network_extension_transparent_proxy",
                    expected_commit="a" * 40,
                    verify_artifact_files=False,
                ),
            )

            no_notarization = deepcopy(receipt)
            no_notarization["notarizationTicketVerified"] = False
            bad_notarization = self.write_json(
                directory, "macos-notarization.json", no_notarization
            )
            self.assert_failure_code(
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                lambda: verify_artifact_gate_receipt(
                    bad_notarization,
                    platform="macos",
                    architecture="aarch64",
                    provider="network_extension_transparent_proxy",
                    expected_commit="a" * 40,
                ),
            )

            wrong_digest_algorithm = deepcopy(receipt)
            wrong_digest_algorithm["candidateBundleDigestAlgorithm"] = "sha256"
            wrong_digest = self.write_json(
                directory, "macos-bundle-digest.json", wrong_digest_algorithm
            )
            self.assert_failure_code(
                "MACOS_RELEASE_POLICY_MISMATCH",
                lambda: verify_artifact_gate_receipt(
                    wrong_digest,
                    platform="macos",
                    architecture="aarch64",
                    provider="network_extension_transparent_proxy",
                    expected_commit="a" * 40,
                ),
            )

    def test_linux_configured_artifact_receipts_accept_canonical_deb_and_rpm(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for kind in ("deb", "rpm"):
                receipt = linux_artifact_receipt(kind=kind)
                path = self.write_json(directory, f"linux-{kind}.json", receipt)
                verify_artifact_gate_receipt(
                    path,
                    platform="linux",
                    architecture="x86_64",
                    provider="cgroup_v2_nft_tun",
                    expected_commit="a" * 40,
                )

    def test_linux_artifact_receipt_rejects_unconfigured_or_mismatched_policy(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            receipt = linux_artifact_receipt()
            unconfigured = self.write_json(directory, "unconfigured.json", receipt)
            self.assert_failure_code(
                "LINUX_RELEASE_POLICY_UNCONFIGURED",
                lambda: _verify_artifact_gate_receipt(
                    unconfigured,
                    platform="linux",
                    architecture="x86_64",
                    provider="cgroup_v2_nft_tun",
                    verify_artifact_files=False,
                ),
            )

            wrong_policy = deepcopy(receipt)
            wrong_policy["releasePolicySha256"] = "0" * 64
            mismatch = self.write_json(directory, "mismatch.json", wrong_policy)
            self.assert_failure_code(
                "LINUX_RELEASE_POLICY_MISMATCH",
                lambda: verify_artifact_gate_receipt(
                    mismatch,
                    platform="linux",
                    architecture="x86_64",
                    provider="cgroup_v2_nft_tun",
                ),
            )

    def test_linux_artifact_receipt_rejects_noncanonical_paths_and_version(
        self,
    ) -> None:
        mutations = (
            (
                "deb-signature",
                "deb",
                lambda value: value.update(signaturePath="/release/detached.asc"),
            ),
            (
                "rpm-signature",
                "rpm",
                lambda value: value.update(signaturePath="/release/detached.rpm"),
            ),
            (
                "wrong-extension",
                "deb",
                lambda value: value.update(packagePath="/release/taomni.pkg"),
            ),
            (
                "relative-path",
                "deb",
                lambda value: value.update(packageManifestPath="evidence/package.json"),
            ),
            (
                "noncanonical-path",
                "deb",
                lambda value: value.update(
                    packageSigningPublicKey="/release/../release/key.asc"
                ),
            ),
            (
                "invalid-version",
                "deb",
                lambda value: value.update(packageVersion="../1.2.3"),
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            for name, kind, mutate in mutations:
                with self.subTest(name=name):
                    receipt = linux_artifact_receipt(kind=kind)
                    mutate(receipt)
                    path = self.write_json(directory, f"{name}.json", receipt)
                    self.assert_failure_code(
                        "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                        lambda path=path: verify_artifact_gate_receipt(
                            path,
                            platform="linux",
                            architecture="x86_64",
                            provider="cgroup_v2_nft_tun",
                        ),
                    )

    def test_linux_artifact_receipt_requires_fixed_package_dependencies(self) -> None:
        mutations = (
            lambda value: value["packageDependencies"].update(required=["nftables"]),
            lambda value: value["packageDependencies"].update(packageMetadata=[]),
            lambda value: value.update(packageDependenciesVerified=False),
        )
        with tempfile.TemporaryDirectory() as directory:
            for index, mutate in enumerate(mutations):
                receipt = linux_artifact_receipt()
                mutate(receipt)
                path = self.write_json(directory, f"dependencies-{index}.json", receipt)
                self.assert_failure_code(
                    "LINUX_RELEASE_POLICY_MISMATCH"
                    if index < 2
                    else "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                    lambda path=path: verify_artifact_gate_receipt(
                        path,
                        platform="linux",
                        architecture="x86_64",
                        provider="cgroup_v2_nft_tun",
                    ),
                )

    def test_linux_bound_manifests_accept_deb_and_rpm_signature_models(self) -> None:
        for kind in ("deb", "rpm"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                _, receipt, policy_override = write_linux_artifact_fixture(
                    Path(directory), kind
                )
                verify_linux_bound_manifests(receipt, policy_override[0])

    def test_linux_bound_manifest_rejects_fake_scripts(self) -> None:
        mutations = (
            lambda manifest: manifest["packageScripts"]["phases"][
                next(iter(manifest["packageScripts"]["phases"]))
            ].update(logicalName="post-remove"),
            lambda manifest: manifest["packageScripts"]["phases"].update(
                fake={
                    "logicalName": "post-install",
                    "rawSha256": "f" * 64,
                    "normalizedSha256": "f" * 64,
                    "size": 1,
                    "interpreter": "/bin/sh",
                }
            ),
            lambda manifest: manifest["packageScripts"]["phases"][
                next(iter(manifest["packageScripts"]["phases"]))
            ].update(rawSha256="f" * 64),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                _, receipt, policy_override = write_linux_artifact_fixture(
                    Path(directory), "deb"
                )
                rewrite_package_manifest(receipt, mutate)
                self.assert_failure_code(
                    "LINUX_RELEASE_POLICY_MISMATCH",
                    lambda: verify_linux_bound_manifests(receipt, policy_override[0]),
                )

    def test_linux_bound_manifest_rejects_fake_entries_name_and_version(self) -> None:
        def add_unsafe_entry(manifest: dict) -> None:
            manifest["entries"].append(
                {
                    "path": "/etc/cron.d/taomni-backdoor",
                    "type": "file",
                    "mode": "0644",
                    "owner": "root",
                    "group": "root",
                    "size": 1,
                    "sha256": "f" * 64,
                    "linkTarget": "",
                }
            )

        def mutate_first_entry(manifest: dict, **changes) -> None:
            manifest["entries"][0].update(changes)

        mutations = (
            ("name", lambda manifest: manifest.update(packageName="taomni-fake")),
            ("version", lambda manifest: manifest.update(packageVersion="9.9.9")),
            ("unsafe-entry", add_unsafe_entry),
            (
                "entry-type",
                lambda manifest: mutate_first_entry(manifest, type="symlink"),
            ),
            (
                "entry-owner",
                lambda manifest: mutate_first_entry(manifest, owner="user"),
            ),
            ("entry-mode", lambda manifest: mutate_first_entry(manifest, mode="0775")),
            (
                "entry-hash",
                lambda manifest: mutate_first_entry(manifest, sha256="f" * 64),
            ),
            (
                "entry-extra-proof",
                lambda manifest: mutate_first_entry(manifest, verified=True),
            ),
            (
                "missing-fixed-payload",
                lambda manifest: manifest["entries"].pop(),
            ),
        )
        for name, mutate in mutations:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                _, receipt, policy_override = write_linux_artifact_fixture(
                    Path(directory), "deb"
                )
                rewrite_package_manifest(receipt, mutate)
                self.assert_failure_code(
                    "PLATFORM_ARTIFACT_RECEIPT_INVALID"
                    if name
                    in {
                        "name",
                        "version",
                        "unsafe-entry",
                        "entry-type",
                        "entry-owner",
                        "entry-mode",
                        "entry-extra-proof",
                        "missing-fixed-payload",
                    }
                    else "LINUX_RELEASE_POLICY_MISMATCH",
                    lambda: verify_linux_bound_manifests(receipt, policy_override[0]),
                )

    def test_linux_bound_manifest_binds_dependency_metadata_to_receipt(self) -> None:
        mutations = (
            lambda manifest: manifest["packageDependencies"].update(
                required=["nftables"]
            ),
            lambda manifest: manifest["packageDependencies"].update(
                packageMetadata=["fake-provider"]
            ),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                _, receipt, policy_override = write_linux_artifact_fixture(
                    Path(directory), "deb"
                )
                rewrite_package_manifest(receipt, mutate)
                self.assert_failure_code(
                    "LINUX_RELEASE_POLICY_MISMATCH",
                    lambda: verify_linux_bound_manifests(receipt, policy_override[0]),
                )

    def test_linux_artifact_gate_rehashes_every_bound_file(self) -> None:
        path_keys = (
            "artifactManifestPath",
            "packagePath",
            "signaturePath",
            "packageSigningPublicKey",
            "packageManifestPath",
            "application",
            "helper",
            "helperPolicy",
            "polkitAction",
        )
        for key in path_keys:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                receipt_path, receipt, policy_override = write_linux_artifact_fixture(
                    Path(directory), "deb"
                )
                candidate = Path(receipt[key])
                candidate.write_bytes(candidate.read_bytes() + b"tampered")
                self.assert_failure_code(
                    "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                    lambda: _verify_artifact_gate_receipt(
                        receipt_path,
                        platform="linux",
                        architecture="x86_64",
                        provider="cgroup_v2_nft_tun",
                        expected_commit="a" * 40,
                        linux_policy_override=policy_override,
                    ),
                )

    def test_linux_artifact_gate_rejects_symlink_and_mode_substitution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            receipt_path, receipt, policy_override = write_linux_artifact_fixture(
                Path(directory), "deb"
            )
            helper = Path(receipt["helper"])
            substitute = helper.with_name("substitute-helper")
            substitute.write_bytes(helper.read_bytes())
            substitute.chmod(0o755)
            helper.unlink()
            helper.symlink_to(substitute)
            self.assert_failure_code(
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                lambda: _verify_artifact_gate_receipt(
                    receipt_path,
                    platform="linux",
                    architecture="x86_64",
                    provider="cgroup_v2_nft_tun",
                    linux_policy_override=policy_override,
                ),
            )

        with tempfile.TemporaryDirectory() as directory:
            receipt_path, receipt, policy_override = write_linux_artifact_fixture(
                Path(directory), "deb"
            )
            Path(receipt["helper"]).chmod(0o644)
            self.assert_failure_code(
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                lambda: _verify_artifact_gate_receipt(
                    receipt_path,
                    platform="linux",
                    architecture="x86_64",
                    provider="cgroup_v2_nft_tun",
                    linux_policy_override=policy_override,
                ),
            )

    def test_linux_helper_capability_check_uses_the_hashed_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            helper = Path(directory) / "sockscap-helper"
            helper.write_bytes(b"helper")
            helper.chmod(0o755)
            seen_targets: list[object] = []

            def no_capability(target, name):
                seen_targets.append(target)
                self.assertEqual(name, "security.capability")
                raise OSError(errno.ENODATA, "no capability")

            with mock.patch.object(os, "getxattr", side_effect=no_capability):
                verify_linux_receipt_artifact_file(
                    str(helper),
                    hashlib.sha256(helper.read_bytes()).hexdigest(),
                    "helper",
                    expected_uid=os.getuid(),
                    expected_gid=os.getgid(),
                    expected_mode=0o755,
                    require_no_file_capabilities=True,
                )
            self.assertEqual(len(seen_targets), 1)
            self.assertIsInstance(seen_targets[0], int)

    def test_linux_install_provenance_requires_real_bound_full_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact_receipt = linux_artifact_receipt()
            artifact_path = self.write_json(
                directory, "artifact.json", artifact_receipt
            )
            provenance_path, provenance, provenance_raw = linux_install_provenance(
                root, artifact_path, artifact_receipt
            )
            self.assertEqual(
                verify_linux_install_provenance(
                    provenance_path,
                    artifact_gate_path=artifact_path,
                    artifact_receipt=artifact_receipt,
                    expected_commit="a" * 40,
                    expected_architecture="x86_64",
                    expected_provider="cgroup_v2_nft_tun",
                ),
                set(provenance_raw),
            )

            mutations = (
                ("candidate", lambda value: value["package"].update(sha256="f" * 64)),
                (
                    "previous-version",
                    lambda value: value["previousSignedPackage"].update(
                        version="1.2.3-1"
                    ),
                ),
                (
                    "previous-signature",
                    lambda value: value["previousSignedPackage"].update(
                        signatureVerified=False
                    ),
                ),
                ("upgrade", lambda value: value["checks"].update(upgrade="FAIL")),
                (
                    "dirty-state",
                    lambda value: value["checks"].update(dirtyStateBlocker="SKIP"),
                ),
                (
                    "package-db",
                    lambda value: value["checks"].update(packageDatabase="FAIL"),
                ),
                (
                    "root-policy",
                    lambda value: value["checks"].update(rootPolicy="FAIL"),
                ),
                (
                    "final-residue",
                    lambda value: value["checks"].update(finalResidue="FAIL"),
                ),
                ("synthetic", lambda value: value["lab"].update(synthetic=True)),
                ("raw-kinds", lambda value: value["rawEvidence"].pop()),
            )
            for index, (name, mutate) in enumerate(mutations):
                changed = deepcopy(provenance)
                mutate(changed)
                changed_path = self.write_json(
                    directory, f"provenance-{index}.json", changed
                )
                self.assert_failure_code(
                    "LINUX_INSTALL_PROVENANCE_MISMATCH"
                    if name == "candidate"
                    else (
                        "LINUX_INSTALL_PROVENANCE_FAILED"
                        if name
                        in {
                            "upgrade",
                            "dirty-state",
                            "package-db",
                            "root-policy",
                            "final-residue",
                        }
                        else "LINUX_INSTALL_PROVENANCE_INVALID"
                    ),
                    lambda changed_path=changed_path: verify_linux_install_provenance(
                        changed_path,
                        artifact_gate_path=artifact_path,
                        artifact_receipt=artifact_receipt,
                        expected_commit="a" * 40,
                        expected_architecture="x86_64",
                        expected_provider="cgroup_v2_nft_tun",
                    ),
                )

            for check in LINUX_INSTALL_CHECKS:
                changed = deepcopy(provenance)
                changed["checks"][check] = "FAIL"
                changed_path = self.write_json(
                    directory, f"provenance-check-{check}.json", changed
                )
                self.assert_failure_code(
                    "LINUX_INSTALL_PROVENANCE_FAILED",
                    lambda changed_path=changed_path: verify_linux_install_provenance(
                        changed_path,
                        artifact_gate_path=artifact_path,
                        artifact_receipt=artifact_receipt,
                        expected_commit="a" * 40,
                        expected_architecture="x86_64",
                        expected_provider="cgroup_v2_nft_tun",
                    ),
                )

            for raw_path in provenance_raw:
                original = raw_path.read_bytes()
                raw_path.write_bytes(original + b"tampered")
                self.assert_failure_code(
                    "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                    lambda: verify_linux_install_provenance(
                        provenance_path,
                        artifact_gate_path=artifact_path,
                        artifact_receipt=artifact_receipt,
                        expected_commit="a" * 40,
                        expected_architecture="x86_64",
                        expected_provider="cgroup_v2_nft_tun",
                    ),
                )
                raw_path.write_bytes(original)

    def test_linux_aggregate_requires_typed_install_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = {}
            for name in ("artifactGate", "nativeSmoke", "coreQuick", "coreSoak"):
                evidence_path = root / f"{name}.json"
                evidence_path.write_text("{}", encoding="utf-8")
                evidence[name] = {
                    "passed": True,
                    "path": evidence_path.name,
                    "sha256": sha256_file(evidence_path),
                }
            manifest = {
                "schemaVersion": 1,
                "releaseEvidence": True,
                "platform": "linux",
                "architecture": "x86_64",
                "gitCommit": "a" * 40,
                "captureProvider": "cgroup_v2_nft_tun",
                "host": {"id": "lab", "osVersion": "test", "hardware": "vm"},
                "startedAtUnix": 1,
                "finishedAtUnix": 2,
                "evidence": evidence,
            }
            manifest_path = self.write_json(directory, "manifest.json", manifest)
            self.assert_failure_code(
                "EVIDENCE_SHAPE_INVALID",
                lambda: verify_platform_manifest(manifest_path, "a" * 40),
            )

    def test_linux_aggregate_fails_closed_without_lab_attestation_identity(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact_receipt = linux_artifact_receipt()
            artifact_path = self.write_json(
                directory, "artifact.json", artifact_receipt
            )
            provenance_path, _, provenance_raw = linux_install_provenance(
                root, artifact_path, artifact_receipt
            )

            native = native_receipt()
            native["artifactGateSha256"] = sha256_file(artifact_path)
            native["artifacts"] = {
                "applicationSha256": artifact_receipt["applicationSha256"],
                "privilegedComponentSha256": artifact_receipt["helperSha256"],
                "providerSha256": artifact_receipt["helperSha256"],
            }
            native_path = self.write_json(directory, "native.json", native)
            quick_path = self.write_json(directory, "quick.json", core_receipt())
            soak_path = self.write_json(
                directory,
                "soak.json",
                core_receipt(mode="soak", duration_seconds=86_400),
            )
            primary = {
                "artifactGate": artifact_path,
                "nativeSmoke": native_path,
                "coreQuick": quick_path,
                "coreSoak": soak_path,
                "linuxInstallProvenance": provenance_path,
            }
            evidence = {
                name: {
                    "passed": True,
                    "path": path.name,
                    "sha256": sha256_file(path),
                }
                for name, path in primary.items()
            }
            raw_paths = list(provenance_raw)
            for index in range(3):
                raw_path = root / f"additional-{index}.log"
                raw_path.write_text(f"raw evidence {index}\n", encoding="utf-8")
                raw_paths.append(raw_path)
            manifest = {
                "schemaVersion": 1,
                "releaseEvidence": True,
                "platform": "linux",
                "architecture": "x86_64",
                "gitCommit": "a" * 40,
                "captureProvider": "cgroup_v2_nft_tun",
                "host": {"id": "lab", "osVersion": "test", "hardware": "vm"},
                "startedAtUnix": 1_700_000_000,
                "finishedAtUnix": 1_700_086_400,
                "evidence": evidence,
                "captureMatrix": {
                    "globalIpv4Tcp": True,
                    "globalIpv6Tcp": True,
                    "applicationGroupIpv4Tcp": True,
                    "runtimePidIpv4Tcp": True,
                    "dnsCaptured": True,
                    "udpPolicyEnforced": True,
                    "hardBypassVerified": True,
                },
                "performance": {
                    "tcpConnect": {
                        "sampleCount": 100,
                        "directMedianMicros": 1_000,
                        "capturedMedianMicros": 2_000,
                        "overheadMedianMicros": 1_000,
                    },
                    "throughput": {
                        "sampleSeconds": 60,
                        "linkCapacityMbps": 1_000,
                        "directMbps": 900,
                        "capturedMbps": 810,
                        "capturedToDirectRatio": 0.9,
                    },
                },
                "stability": {
                    "durationSeconds": 86_400,
                    "startStopCycles": 100,
                    "unexpectedAppExits": 0,
                    "unexpectedHelperExits": 0,
                    "rssGrowthBytes": 0,
                    "openHandleGrowth": 0,
                    "cleanupChecks": 100,
                    "residueFailures": 0,
                    "killMainRecovered": True,
                    "killHelperRecovered": True,
                    "restartRecovered": True,
                    "sleepWakePassed": True,
                    "nicSwitchPassed": True,
                    "vpnCoexistencePassed": True,
                },
                "leakAudit": {
                    "dnsPassed": True,
                    "ipv4Passed": True,
                    "ipv6Passed": True,
                    "udpPassed": True,
                },
                "rawEvidence": [
                    {
                        "name": f"raw-{index}",
                        "path": path.name,
                        "sha256": sha256_file(path),
                    }
                    for index, path in enumerate(raw_paths)
                ],
            }
            manifest_path = self.write_json(directory, "platform.json", manifest)
            globals_dict = verify_platform_manifest.__globals__
            original = globals_dict["verify_artifact_gate_receipt"]
            globals_dict["verify_artifact_gate_receipt"] = lambda *args, **kwargs: None
            try:
                self.assert_failure_code(
                    "LINUX_INSTALL_PROVENANCE_ATTESTATION_UNCONFIGURED",
                    lambda: verify_platform_manifest(manifest_path, "a" * 40),
                )
            finally:
                globals_dict["verify_artifact_gate_receipt"] = original

    def test_non_linux_aggregate_does_not_consume_linux_install_provenance(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = {}
            for name in ("artifactGate", "nativeSmoke", "coreQuick", "coreSoak"):
                evidence_path = root / f"{name}.json"
                evidence_path.write_text("{}", encoding="utf-8")
                evidence[name] = {
                    "passed": True,
                    "path": evidence_path.name,
                    "sha256": sha256_file(evidence_path),
                }
            manifest = {
                "schemaVersion": 1,
                "releaseEvidence": True,
                "platform": "windows",
                "architecture": "x86_64",
                "gitCommit": "a" * 40,
                "captureProvider": "windivert",
                "host": {"id": "lab", "osVersion": "test", "hardware": "vm"},
                "startedAtUnix": 1,
                "finishedAtUnix": 2,
                "evidence": evidence,
            }
            manifest_path = self.write_json(directory, "windows.json", manifest)
            globals_dict = verify_platform_manifest.__globals__
            platform_names = globals_dict["PLATFORM_NAMES"]
            original_platform = platform_names.get(sys.platform)
            original_verify = globals_dict["verify_artifact_gate_receipt"]

            def reached_artifact_gate(*args, **kwargs):
                raise GateFailure("TEST_REACHED_ARTIFACT_GATE", "expected")

            platform_names[sys.platform] = "windows"
            globals_dict["verify_artifact_gate_receipt"] = reached_artifact_gate
            try:
                self.assert_failure_code(
                    "TEST_REACHED_ARTIFACT_GATE",
                    lambda: verify_platform_manifest(manifest_path, "a" * 40),
                )
            finally:
                globals_dict["verify_artifact_gate_receipt"] = original_verify
                if original_platform is None:
                    del platform_names[sys.platform]
                else:
                    platform_names[sys.platform] = original_platform

    def test_performance_template_keeps_linux_install_provenance_disabled(self) -> None:
        template_path = (
            Path(__file__).parents[2]
            / "src-tauri/platform/sockscap/performance-release-manifest.template.json"
        )
        lint_platform_template(template_path)
        template = json.loads(template_path.read_text(encoding="utf-8"))
        self.assertEqual(
            template["evidence"]["linuxInstallProvenance"],
            {"passed": False, "path": "", "sha256": ""},
        )

    def test_artifact_file_is_rehashed_on_the_aggregate_host(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "artifact.bin")
            path.write_bytes(b"candidate-a")
            expected = hashlib.sha256(b"candidate-a").hexdigest()
            verify_receipt_artifact_file(str(path), expected, "artifactGate.test")
            path.write_bytes(b"candidate-b")
            self.assert_failure_code(
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                lambda: verify_receipt_artifact_file(
                    str(path), expected, "artifactGate.test"
                ),
            )

    def test_candidate_bundle_is_rehashed_on_the_aggregate_host(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory, "Taomni.app")
            executable = bundle / "Contents/MacOS/taomni"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"candidate-a")
            executable.chmod(0o755)
            expected = directory_tree_sha256(bundle)
            verify_receipt_artifact_directory(str(bundle), expected, "artifactGate.app")
            executable.write_bytes(b"candidate-b")
            self.assert_failure_code(
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                lambda: verify_receipt_artifact_directory(
                    str(bundle), expected, "artifactGate.app"
                ),
            )


if __name__ == "__main__":
    unittest.main()
