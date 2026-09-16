"""Exercise real child processes; failed tool execution must never certify code."""
import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import typecheck_scope as gate


class TypecheckGateTest(unittest.TestCase):
    def test_resolves_launcher_and_preserves_arguments(self):
        with patch.object(gate.shutil, "which", return_value="C:/tool space/pnpm.cmd"), patch.object(
            gate.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "ok", "")
        ) as launch:
            self.assertEqual(gate.run_typecheck(["pnpm", "exec", "tsc"], Path.cwd()), ("ok", 0))
            self.assertEqual(launch.call_args.args[0], ["C:/tool space/pnpm.cmd", "exec", "tsc"])

    def test_child_exit_is_retained(self):
        output, code = gate.run_typecheck([sys.executable, "-c", "print('broken'); raise SystemExit(7)"], Path.cwd())
        self.assertEqual(code, 7)
        self.assertIn("broken", output)

    def test_gate_rejects_unclassified_failure_and_global_diagnostics(self):
        for output in ("tool failed", "error TS5083: Cannot read config", "src/other.ts(1,1): error TS2304: missing\nerror TS5083: bad config"):
            with self.subTest(output=output), patch.object(sys, "argv", ["gate", "--path", "src/owned.ts"]), patch.object(
                gate, "run_typecheck", return_value=(output, 1)
            ), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(gate.main(), 2)

    def test_owned_and_external_diagnostics(self):
        for path, expected in (("src/owned.ts", 1), ("src/other.ts", 0)):
            with self.subTest(path=path), patch.object(sys, "argv", ["gate", "--path", "src/owned.ts"]), patch.object(
                gate, "run_typecheck", return_value=(f"{path}(1,1): error TS2304: missing", 1)
            ), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(gate.main(), expected)

    def test_missing_executable_is_check_error(self):
        with patch.object(sys, "argv", ["gate", "--path", "src/owned.ts", "--command", "nonexistent-typecheck-command"]), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.main(), 2)

    def test_imported_log_requires_exit_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "build.log"
            log.write_text("", encoding="utf-8")
            with patch.object(sys, "argv", ["gate", "--path", "src/owned.ts", "--from-file", str(log)]), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                gate.main()
            self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
