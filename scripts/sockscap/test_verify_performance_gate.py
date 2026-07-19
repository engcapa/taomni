#!/usr/bin/env python3
"""Focused fail-closed tests for the Sockscap evidence verifier."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import runpy
import tempfile
import unittest


VERIFIER = runpy.run_path(str(Path(__file__).with_name("verify-performance-gate.py")))
GateFailure = VERIFIER["GateFailure"]
_verify_artifact_gate_receipt = VERIFIER["verify_artifact_gate_receipt"]
verify_core_receipt = VERIFIER["verify_core_receipt"]
verify_native_smoke_receipt = VERIFIER["verify_native_smoke_receipt"]
verify_receipt_artifact_file = VERIFIER["verify_receipt_artifact_file"]
verify_receipt_artifact_directory = VERIFIER[
    "verify_receipt_artifact_directory"
]
directory_tree_sha256 = VERIFIER["directory_tree_sha256"]
windows_release_policy = VERIFIER["windows_release_policy"]
macos_release_policy = VERIFIER["macos_release_policy"]


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


def verify_artifact_gate_receipt(*args, **kwargs):
    """Exercise receipt contracts without requiring fixture files at fake OS paths."""
    kwargs.setdefault("verify_artifact_files", False)
    if kwargs.get("platform") == "windows":
        kwargs.setdefault("windows_policy_override", windows_test_release_policy())
    if kwargs.get("platform") == "macos":
        kwargs.setdefault("macos_policy_override", macos_test_release_policy())
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
            "driverSignerCertificateSha256": windivert[
                "driverSignerCertificateSha256"
            ],
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
        "candidateBundleDigestAlgorithm": policy[
            "candidateBundleDigestAlgorithm"
        ],
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
        self.assertEqual(
            wintun["packageSha256"], policy["wintun"]["packageSha256"]
        )
        self.assertEqual(wintun["sha256"], policy["wintun"]["userModeSha256"])
        self.assertEqual(
            wintun["licenseSha256"], policy["wintun"]["licenseSha256"]
        )
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
            bad_wintun_url["wintun"]["packageUrl"] = "https://example.invalid/wintun.zip"
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
            bad_hash = self.write_json(
                directory, "unpinned-hash.json", unpinned_hash
            )
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
            bad_policy = self.write_json(
                directory, "wrong-policy.json", wrong_policy
            )
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
            verify_receipt_artifact_directory(
                str(bundle), expected, "artifactGate.app"
            )
            executable.write_bytes(b"candidate-b")
            self.assert_failure_code(
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                lambda: verify_receipt_artifact_directory(
                    str(bundle), expected, "artifactGate.app"
                ),
            )


if __name__ == "__main__":
    unittest.main()
