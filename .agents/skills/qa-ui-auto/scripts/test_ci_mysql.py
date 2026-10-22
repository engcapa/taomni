"""The original bootstrap failure must remain diagnosable after cleanup."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from ci_mysql import initialize_mysql


class MysqlBootstrapEvidenceTest(unittest.TestCase):
    def test_exit_failure_preserves_output_and_datadir_error_before_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report"
            with tempfile.TemporaryDirectory() as private:
                data = Path(private)
                (data / "bootstrap.err").write_text("InnoDB bootstrap failed", encoding="utf-8")
                script = "import sys; print('bootstrap fatal', flush=True); sys.exit(2)"
                with self.assertRaisesRegex(RuntimeError, "failed \\(2\\)"):
                    initialize_mysql([sys.executable, "-c", script], data, report)
            self.assertIn("bootstrap fatal", (report / "mysql-initialize.log").read_text())
            self.assertIn("InnoDB bootstrap failed", (report / "mysql-initialize-bootstrap.err").read_text())
            outcome = json.loads((report / "mysql-initialize.json").read_text())
            self.assertEqual(outcome["status"], "failed")
            self.assertEqual(outcome["exit_code"], 2)

    def test_timeout_keeps_partial_output_and_fails_instead_of_reporting_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report"
            script = "import time; print('InnoDB initialization started', flush=True); time.sleep(30)"
            with self.assertRaisesRegex(RuntimeError, "exceeded") as raised:
                initialize_mysql([sys.executable, "-c", script], Path(directory), report, timeout=0.5)
            self.assertIsInstance(raised.exception.__cause__, subprocess.TimeoutExpired)
            self.assertIn("InnoDB initialization started", (report / "mysql-initialize.log").read_text())
            outcome = json.loads((report / "mysql-initialize.json").read_text())
            self.assertEqual(outcome["status"], "timeout")
            self.assertNotIn("exit_code", outcome)

    def test_success_is_recorded_without_capturing_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report"
            initialize_mysql([sys.executable, "-c", "print('bootstrap completed')"], Path(directory), report)
            outcome = json.loads((report / "mysql-initialize.json").read_text())
            self.assertEqual(outcome["status"], "passed")
            self.assertEqual(outcome["exit_code"], 0)
            self.assertNotIn("argv", outcome)


if __name__ == "__main__":
    unittest.main()
