"""Receipt and environment isolation tests; every process call is mocked."""
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
MAIN = runpy.run_path(str(ROOT / "scripts/run-module-network-gates.py"))["main"]
LISTING = "plugin::network::tests::native::app: test\nplugin::network::tests::native::custom: test\n"
SUCCESS = "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 2000 filtered out;\n"


class ModuleNetworkGateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.executable = self.root / "inert-not-executable"
        self.executable.write_bytes(b"unit fixture; no native execution")
        row = {"reason": "compiler-artifact", "target": {"name": "taomni_lib"},
               "profile": {"test": True}, "executable": str(self.executable)}
        (self.root / "core-build.jsonl").write_text(json.dumps(row) + "\n")

    def run_gate(self, listing=LISTING, output=SUCCESS, timeout=False):
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}))
            stack.enter_context(patch("sys.argv", ["gate", "--evidence", str(self.root)]))
            stack.enter_context(patch("builtins.print"))
            stack.enter_context(patch.object(subprocess, "check_output", side_effect=[listing, "a" * 40]))
            execute = stack.enter_context(patch.object(subprocess, "run"))
            execute.return_value = SimpleNamespace(stdout=output, returncode=0)
            if timeout:
                execute.side_effect = subprocess.TimeoutExpired("inert", 60, output=b"partial native log")
            try:
                MAIN()
            except SystemExit as error:
                return error.code, execute

    def test_only_execution_gets_poisoned_proxies_and_receipt_binds_the_actual_core(self):
        code, execute = self.run_gate()
        self.assertEqual(code, 0)
        env = execute.call_args.kwargs["env"]
        for name in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            self.assertEqual(env[name], "http://127.0.0.1:9")
        self.assertEqual(env["NO_PROXY"], "")
        self.assertEqual(env["no_proxy"], "")
        receipt = json.loads((self.root / "module-network-receipt.json").read_text())
        self.assertTrue(receipt["allSelectedPassed"])
        self.assertEqual(receipt["coreSha256"], hashlib.sha256(self.executable.read_bytes()).hexdigest())

    def test_incomplete_selection_or_empty_success_output_cannot_create_a_pass(self):
        code, execute = self.run_gate(listing="")
        self.assertIn("Expected two", code)
        execute.assert_not_called()
        self.assertFalse((self.root / "module-network-receipt.json").exists())
        code, _ = self.run_gate(output="")
        self.assertNotEqual(code, 0)
        receipt = json.loads((self.root / "module-network-receipt.json").read_text())
        self.assertFalse(receipt["allSelectedPassed"])

    def test_timeout_preserves_raw_partial_output_and_a_failed_receipt(self):
        code, _ = self.run_gate(timeout=True)
        self.assertEqual(code, 124)
        self.assertIn("partial native log", (self.root / "module-network-native.log").read_text())
        receipt = json.loads((self.root / "module-network-receipt.json").read_text())
        self.assertFalse(receipt["allSelectedPassed"])


if __name__ == "__main__":
    unittest.main()
