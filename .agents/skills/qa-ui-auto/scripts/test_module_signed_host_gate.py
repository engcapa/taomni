"""Pure receipt/selection checks; every process invocation is mocked."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
GATE = runpy.run_path(str(ROOT / "scripts/run-signed-mfa-host-gates.py"))["main"]
SOURCE = "a" * 40
SELECTED = "\n".join(f"plugin::signed_mfa_host_tests::case_{i}: test" for i in range(3))
SUCCESS = "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 2000 filtered out;\n"


class SignedHostGateReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.evidence = self.root / "evidence"
        self.evidence.mkdir()
        self.executable = self.root / "inert-core-never-executed"
        self.executable.write_bytes(b"unit fixture: no executable host")
        self.row = {"reason": "compiler-artifact", "executable": str(self.executable),
                    "target": {"name": "taomni_lib"}, "profile": {"test": True},
                    "features": ["qa-release-trust-gates"]}
        self.package = self.root / "package"
        self.package.mkdir()
        archive = self.package / "inert.taomni-plugin"
        archive.write_bytes(b"unit receipt fixture: not a trusted package")
        self.receipt = {"sourceSha": SOURCE, "slug": "mfa", "trust": "plugins.updater.pubkey",
                        "archive": archive.name, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                        "platform": "linux-x86_64"}

    def run_gate(self, *, listing=SELECTED, output=SUCCESS, code=0, timeout=False):
        (self.evidence / "core-build.jsonl").write_text(json.dumps(self.row) + "\n")
        (self.package / "provenance.json").write_text(json.dumps(self.receipt))
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {
                "GITHUB_ACTIONS": "true", "TAOMNI_SIGNED_MFA_PACKAGE_DIR": str(self.package),
                "TAOMNI_SIGNED_MFA_SOURCE_SHA": SOURCE,
            }))
            stack.enter_context(patch("sys.argv", ["gate", "--evidence", str(self.evidence)]))
            stack.enter_context(patch("builtins.print"))
            query = stack.enter_context(patch.object(subprocess, "check_output", side_effect=[SOURCE, listing]))
            execute = stack.enter_context(patch.object(subprocess, "run"))
            if timeout:
                execute.side_effect = subprocess.TimeoutExpired("inert", 180, output=b"partial log")
            else:
                execute.return_value = SimpleNamespace(stdout=output, returncode=code)
            try:
                GATE()
            except SystemExit as error:
                return error.code, query, execute

    def saved(self):
        return json.loads((self.evidence / "installed-mfa-receipt.json").read_text())

    def test_matching_three_executed_tests_bind_actual_fixture_bytes(self):
        code, _, execute = self.run_gate()
        self.assertEqual(code, 0)
        receipt = self.saved()
        self.assertTrue(receipt["allSelectedPassed"])
        self.assertTrue(receipt["fixtureKeyRejectionVerified"])
        self.assertEqual(receipt["coreSha256"], hashlib.sha256(self.executable.read_bytes()).hexdigest())
        self.assertEqual(receipt["packageSha256"], self.receipt["sha256"])
        self.assertEqual(receipt["systemTrust"], "unverified")
        self.assertIn("--ignored", execute.call_args.args[0])
        self.assertEqual(execute.call_args.kwargs["timeout"], 180)

    def test_missing_dedicated_trust_feature_selects_no_harness_or_process(self):
        self.row["features"] = []
        code, query, execute = self.run_gate()
        self.assertIn("Expected one dedicated", code)
        query.assert_not_called()
        execute.assert_not_called()

    def test_stale_source_or_package_bytes_cannot_start_a_process(self):
        for change in ["source", "bytes", "path"]:
            with self.subTest(change=change):
                if change == "source":
                    self.receipt["sourceSha"] = "b" * 40
                elif change == "bytes":
                    self.receipt["sourceSha"] = SOURCE
                    self.receipt["sha256"] = "0" * 64
                else:
                    self.receipt["archive"] = "../outside"
                with self.assertRaises(AssertionError):
                    self.run_gate()
                self.assertFalse((self.evidence / "installed-mfa-receipt.json").exists())

    def test_incomplete_listing_cannot_run_or_issue_a_passing_receipt(self):
        with self.assertRaisesRegex(AssertionError, "Expected 3 actual installed gates"):
            self.run_gate(listing="")
        self.assertFalse((self.evidence / "installed-mfa-receipt.json").exists())

    def test_zero_exit_with_skipped_missing_or_failed_tests_is_not_a_pass(self):
        for output, exit_code in [("", 0), (SUCCESS.replace("3 passed", "2 passed"), 0),
                                  (SUCCESS.replace("0 ignored", "1 ignored"), 0), (SUCCESS, 101)]:
            with self.subTest(output=output, exit_code=exit_code):
                code, _, _ = self.run_gate(output=output, code=exit_code)
                self.assertNotEqual(code, 0)
                self.assertFalse(self.saved()["allSelectedPassed"])
                self.assertFalse(self.saved()["fixtureKeyRejectionVerified"])

    def test_timeout_preserves_partial_log_and_a_failed_receipt(self):
        code, _, _ = self.run_gate(timeout=True)
        self.assertEqual(code, 124)
        self.assertFalse(self.saved()["allSelectedPassed"])
        self.assertIn("partial log", (self.evidence / "installed-mfa-process.log").read_text())


if __name__ == "__main__":
    unittest.main()
