"""Pure contracts; never sign code, assess Gatekeeper or launch an application."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "scripts"))
import module_system_execution as shared

SPEC = importlib.util.spec_from_file_location("module_system_gate", ROOT / "scripts/run-module-system-execution-gates.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class SystemExecutionGateTests(unittest.TestCase):
    def test_only_disposable_github_macos_can_run_the_actual_experiment(self):
        for system, actions, runner in [("Linux", "true", "github-hosted"),
                                        ("Darwin", "false", "github-hosted"),
                                        ("Darwin", "true", "self-hosted")]:
            with patch.object(gate.platform, "system", return_value=system), \
                    patch.dict(os.environ, {"GITHUB_ACTIONS": actions, "RUNNER_ENVIRONMENT": runner}):
                with self.assertRaisesRegex(RuntimeError, "disposable GitHub"):
                    gate.require_hosted()
        with patch.object(gate.platform, "system", return_value="Darwin"), \
                patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted"}):
            gate.require_hosted()

    def test_signing_success_requires_both_the_identity_and_actual_runtime_flag(self):
        valid = "CodeDirectory v=20500 size=1 flags=0x10000(runtime)\nSignature=adhoc\n"
        self.assertTrue(gate.hardened_signature(valid)["hardenedRuntime"])
        for output in ["", valid.replace("0x10000", "0x2"), valid.replace("Signature=adhoc", "Authority=Other")]:
            with self.assertRaisesRegex(RuntimeError, "actual ad-hoc"):
                gate.hardened_signature(output)

    def test_fixed_mode_compares_the_extracted_leaf_certificate_and_runtime_flag(self):
        details = "CodeDirectory v=20500 size=1 flags=0x10000(runtime)\nAuthority=Local"
        leaf = b"test certificate bytes"
        expected = hashlib.sha1(leaf, usedforsecurity=False).hexdigest().upper()
        self.assertEqual(gate.hardened_signature(details, expected, leaf)["certificateSha1"], expected)
        with self.assertRaisesRegex(RuntimeError, "pinned release certificate"):
            gate.hardened_signature(details, expected, b"unrelated certificate")
        with self.assertRaisesRegex(RuntimeError, "hardened runtime"):
            gate.hardened_signature(details.replace("0x10000", "0x0"), expected, leaf)
        with self.assertRaisesRegex(RuntimeError, "fixed certificate"):
            gate.hardened_signature(details + "\nSignature=adhoc", expected, leaf)

    def test_harness_selection_rejects_empty_ambiguous_and_non_test_builds(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            paths = [root / "first", root / "second"]
            for path in paths:
                path.write_bytes(b"inert unit artifact, never executed")
            def row(path, test=True):
                return json.dumps({"reason": "compiler-artifact", "target": {"name": "system_execution"},
                                   "profile": {"test": test}, "executable": str(path)})
            self.assertEqual(gate.select_harness(row(paths[0])), paths[0])
            for output in ["no compiler artifacts", row(paths[0], False), row(paths[0]) + "\n" + row(paths[1])]:
                with self.assertRaisesRegex(RuntimeError, "exactly one"):
                    gate.select_harness(output)

    def test_failed_and_timed_out_commands_preserve_the_original_diagnostics(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = subprocess.CompletedProcess(["inert"], 23, "stdout", "stderr")
            with patch.object(shared.subprocess, "run", return_value=result) as execute:
                with self.assertRaisesRegex(RuntimeError, "exit 23"):
                    gate.run_command(["inert"], root, "failed")
                self.assertEqual((root / "failed.log").read_text(), "stdoutstderr")
                self.assertEqual(execute.call_count, 1)
            with patch.object(shared.subprocess, "run", side_effect=subprocess.TimeoutExpired("inert", 1, b"partial", b"error")):
                code, output = gate.run_command(["inert"], root, "timeout", check=False)
                self.assertEqual(code, 124)
                self.assertIn("partial", output)
                self.assertIn("error", output)
                self.assertIn("deadline", (root / "timeout.log").read_text())

    def test_build_failure_still_writes_a_receipt_without_claiming_platform_trust(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(gate, "require_hosted"), \
                    patch.object(gate, "run_command", side_effect=[(0, "a" * 40), RuntimeError("build failed")]):
                with self.assertRaisesRegex(RuntimeError, "build failed"):
                    gate.run(root)
            receipt = json.loads((root / "system-execution-receipt.json").read_text())
            self.assertFalse(receipt["allSelectedPassed"])
            for boundary in ["releasePackage", "fixedCertificate", "tcc"]:
                self.assertEqual(receipt[boundary], "unverified")


if __name__ == "__main__":
    unittest.main()
