#!/usr/bin/env python3
"""Focused fail-closed tests for the Sockscap evidence verifier."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import runpy
import tempfile
import unittest


VERIFIER = runpy.run_path(str(Path(__file__).with_name("verify-performance-gate.py")))
GateFailure = VERIFIER["GateFailure"]
verify_artifact_gate_receipt = VERIFIER["verify_artifact_gate_receipt"]
verify_core_receipt = VERIFIER["verify_core_receipt"]
verify_native_smoke_receipt = VERIFIER["verify_native_smoke_receipt"]


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
        "schema": "qa-ui-auto.summary.v1",
        "mode": "native",
        "totals": {"total": 1, "passed": 1, "failed": 0, "skipped": 0},
        "cases": [
            {
                "id": "TC-SOCKSCAP-native-window-smoke",
                "status": "passed",
                "modes": ["native"],
            }
        ],
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
        receipt = {
            "platform": "windows",
            "mode": "lint",
            "result": "PASS",
            "architecture": "x86_64",
            "applicationCaptureProvider": "wfp",
            "application": "taomni.exe",
            "helper": "helper.exe",
            "wintun": "wintun.dll",
        }
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "artifact.json", receipt)
            self.assert_failure_code(
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                lambda: verify_artifact_gate_receipt(
                    path,
                    platform="windows",
                    architecture="x86_64",
                    provider="wfp",
                ),
            )

    def test_native_smoke_requires_real_native_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            good = self.write_json(directory, "native.json", native_receipt())
            verify_native_smoke_receipt(good)
            bad_receipt = native_receipt()
            bad_receipt["mode"] = "browser"
            bad = self.write_json(directory, "browser.json", bad_receipt)
            self.assert_failure_code(
                "PLATFORM_NATIVE_SMOKE_INVALID",
                lambda: verify_native_smoke_receipt(bad),
            )


if __name__ == "__main__":
    unittest.main()
