import json
import tempfile
import unittest
from pathlib import Path

from ci_execute import _classify_runner_result


class ExecuteOutcomeTests(unittest.TestCase):
    def write_summary(self, root: Path, *, identity_stable: bool = True) -> None:
        run = root / "run-example"
        run.mkdir(parents=True)
        (run / "summary.json").write_text(json.dumps({
            "dry_run": False,
            "identity_stable": identity_stable,
            "cases": [{"id": "TC-example", "status": "failed"}],
            "totals": {"total": 1, "passed": 0, "failed": 1, "skipped": 0},
        }), encoding="utf-8")

    def test_complete_failure_report_is_a_successful_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_summary(root)

            result = _classify_runner_result(root, runner_exit_code=1)

            self.assertEqual(result["exit_code"], 0)
            self.assertEqual(result["runner_exit_code"], 1)
            self.assertEqual(result["case_result_exit_code"], 1)
            self.assertNotIn("error", result)

    def test_missing_report_is_an_execution_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            result = _classify_runner_result(Path(directory), runner_exit_code=1)

            self.assertEqual(result["exit_code"], 1)
            self.assertIn("did not produce summary.json", result["error"])

    def test_unstable_identity_is_an_execution_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_summary(root, identity_stable=False)

            result = _classify_runner_result(root, runner_exit_code=1)

            self.assertEqual(result["exit_code"], 1)
            self.assertIn("identity is unstable", result["error"])


if __name__ == "__main__":
    unittest.main()
