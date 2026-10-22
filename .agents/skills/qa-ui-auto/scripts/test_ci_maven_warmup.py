"""Retained failed-transfer evidence, retry boundaries and real warmup wiring."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import ci_maven_warmup as warmup
import ci_toolchains


TRANSFER = "Could not transfer artifact org.example:parent:pom:1 from/to central: status code: 502"


def result(code=0, stdout="", stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class MavenWarmupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = self.root / "project"
        self.project.mkdir()
        self.report = self.root / "report"
        self.command = ["/tools/mvn", "-q", "dependency:go-offline", "package"]

    def run_warmup(self):
        return warmup.warm_maven(self.command, self.project, self.report)

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    def test_transfer_retry_forces_remote_resolution_and_retains_both_attempts(self, run, sleep):
        run.side_effect = [result(1, TRANSFER), result(0, "cached successfully")]
        self.assertEqual(self.run_warmup(), "cached successfully")
        self.assertEqual(run.call_args_list[0].args[0], self.command)
        self.assertEqual(run.call_args_list[1].args[0], ["/tools/mvn", "-U", *self.command[1:]])
        self.assertEqual(run.call_args_list[1].kwargs["cwd"], self.project)
        self.assertEqual(self.command, ["/tools/mvn", "-q", "dependency:go-offline", "package"])
        sleep.assert_called_once_with(1)
        self.assertIn(TRANSFER, (self.report / "maven-single-attempt-1.log").read_text())
        self.assertIn("exit_code: 0", (self.report / "maven-single-attempt-2.log").read_text())

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    def test_persistent_transient_failure_is_fatal_after_three_attempts(self, run, sleep):
        run.return_value = result(1, stderr=TRANSFER)
        with self.assertRaisesRegex(RuntimeError, "status code: 502"):
            self.run_warmup()
        self.assertEqual(run.call_count, 3)
        self.assertEqual([call.args for call in sleep.call_args_list], [(1,), (2,)])
        self.assertEqual(len(list(self.report.glob("*.log"))), 3)

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    def test_permanent_repository_and_compiler_errors_are_not_retried(self, run, sleep):
        for message in [TRANSFER.replace("502", "404"), TRANSFER.replace("502", "401"),
                        "Compilation failure: cannot find symbol status code: 502"]:
            with self.subTest(message=message):
                run.reset_mock()
                run.return_value = result(1, message)
                with self.assertRaises(RuntimeError):
                    self.run_warmup()
                self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    def test_transfer_statuses_and_connection_failure(self, run, sleep):
        for suffix in ["status code: 408", "status code: 429", "status code: 503",
                       "Read timed out", "Connection reset", "Temporary failure in name resolution"]:
            with self.subTest(suffix=suffix):
                run.reset_mock()
                run.side_effect = [result(1, "Could not transfer artifact parent: " + suffix), result()]
                self.run_warmup()
                self.assertEqual(run.call_count, 2)

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    @patch.object(warmup.time, "monotonic")
    def test_retries_share_original_300_second_budget(self, monotonic, run, sleep):
        now = [100.0]
        monotonic.side_effect = lambda: now[0]
        sleep.side_effect = lambda delay: now.__setitem__(0, now[0] + delay)
        def execute(*args, **kwargs):
            if run.call_count == 1:
                now[0] += 80
                return result(1, TRANSFER)
            return result()
        run.side_effect = execute
        self.run_warmup()
        self.assertEqual([c.kwargs["timeout"] for c in run.call_args_list], [300, 219])

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    @patch.object(warmup.time, "monotonic", side_effect=[0, 0, 299.5])
    def test_exhausted_budget_does_not_start_another_attempt(self, monotonic, run, sleep):
        run.return_value = result(1, TRANSFER)
        with self.assertRaisesRegex(RuntimeError, "status code: 502"):
            self.run_warmup()
        run.assert_called_once()
        sleep.assert_not_called()

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    def test_process_timeout_is_fatal_with_partial_output_retained(self, run, sleep):
        run.side_effect = subprocess.TimeoutExpired(self.command, 300, output=b"connecting", stderr=b"server stalled")
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_warmup()
        run.assert_called_once()
        sleep.assert_not_called()
        text = (self.report / "maven-single-attempt-1.log").read_text()
        self.assertIn("status: timeout", text)
        self.assertIn("connecting", text)
        self.assertIn("server stalled", text)

    @patch.object(ci_toolchains, "warm_maven")
    @patch.object(ci_toolchains.shutil, "which", return_value="/tools/mvn")
    @patch("qa_ui_auto.fixtures.java25_projects._gradle_binary", return_value="/tools/gradle")
    def test_real_warm_projects_uses_transfer_retry_for_pom_preparation(self, gradle, which, warm):
        ci_toolchains.warm_projects(self.root, ["java"])
        warm.assert_called_once_with(self.command, self.root / "warm-maven-single", self.root)
        self.assertIn("<artifactId>maven-single</artifactId>",
                      (self.root / "warm-maven-single/pom.xml").read_text())
        self.assertTrue((self.root / "warmup.json").is_file())


if __name__ == "__main__":
    unittest.main()
