"""Retained failed-transfer evidence, retry boundaries and real warmup wiring."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import ci_maven_warmup as warmup
import ci_toolchains


TRANSFER = "Could not transfer artifact org.example:parent:pom:1 from/to central: status code: 502"
OPTIONS = list(warmup.MAVEN_RETRY_OPTIONS)


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
        self.assertEqual(run.call_args_list[0].args[0], ["/tools/mvn", *OPTIONS, "-q",
                                                         "dependency:go-offline", "package"])
        self.assertEqual(run.call_args_list[1].args[0], ["/tools/mvn", "-U", *OPTIONS, "-q",
                                                         "dependency:go-offline", "package"])
        self.assertEqual(run.call_args_list[1].kwargs["cwd"], self.project)
        self.assertEqual(self.command, ["/tools/mvn", "-q", "dependency:go-offline", "package"])
        sleep.assert_called_once_with(5.0)
        self.assertIn(TRANSFER, (self.report / "maven-single-attempt-1.log").read_text())
        self.assertIn("exit_code: 0", (self.report / "maven-single-attempt-2.log").read_text())
        for call in run.call_args_list:
            self.assertIn("-Daether.connector.http.retryHandler.count=5", call.args[0])

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    def test_persistent_transient_failure_is_fatal_after_three_attempts(self, run, sleep):
        run.return_value = result(1, stderr=TRANSFER)
        with self.assertRaisesRegex(RuntimeError, "status code: 502"):
            self.run_warmup()
        self.assertEqual(run.call_count, 3)
        self.assertEqual([call.args for call in sleep.call_args_list], [(5.0,), (15.0,)])
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
                       "HTTP Status: 429", "HTTP Status: 503",
                       "Read timed out", "Connection reset", "Temporary failure in name resolution"]:
            with self.subTest(suffix=suffix):
                run.reset_mock()
                run.side_effect = [result(1, "Could not transfer artifact parent: " + suffix), result()]
                self.run_warmup()
                self.assertEqual(run.call_count, 2)

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    @patch.object(warmup.time, "monotonic")
    def test_retries_share_the_budget_and_each_attempt_uses_its_own_timeout(self, monotonic, run, sleep):
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
        self.assertEqual([call.kwargs["timeout"] for call in run.call_args_list], [240, 240])

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    @patch.object(warmup.time, "monotonic")
    def test_exhausted_budget_does_not_start_another_attempt(self, monotonic, run, sleep):
        monotonic.side_effect = [0.0, 0.0, 9.9]
        run.return_value = result(1, TRANSFER)
        with patch.dict(os.environ, {"QA_MAVEN_WARMUP_BUDGET": "10"}):
            with self.assertRaisesRegex(RuntimeError, "status code: 502"):
                self.run_warmup()
        run.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(run.call_args.kwargs["timeout"], 10.0)

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    def test_process_timeout_is_retried_and_partial_output_is_retained(self, run, sleep):
        run.side_effect = [subprocess.TimeoutExpired(self.command, 240, output=b"connecting",
                                                     stderr=b"server stalled"),
                           result(0, "cached successfully")]
        self.assertEqual(self.run_warmup(), "cached successfully")
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(5.0)
        text = (self.report / "maven-single-attempt-1.log").read_text()
        self.assertIn("status: timeout", text)
        self.assertIn("connecting", text)

    @patch.object(warmup.time, "sleep")
    @patch.object(warmup.subprocess, "run")
    def test_exhausted_timeouts_keep_every_attempt_log(self, run, sleep):
        run.side_effect = subprocess.TimeoutExpired(self.command, 240, output=b"connecting",
                                                    stderr=b"server stalled")
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            self.run_warmup()
        self.assertEqual(run.call_count, 3)
        self.assertEqual(len(list(self.report.glob("*.log"))), 3)

    def test_transient_classifier_covers_maven_and_gradle_transfers_only(self):
        self.assertTrue(warmup.transient_failure(
            "Could not resolve all files for configuration ':compileClasspath'. Read timed out"))
        self.assertTrue(warmup.transient_failure(
            "Could not download maven-resources-plugin-3.5.0.jar (HTTP Status: 429)"))
        self.assertTrue(warmup.transient_failure(
            "Could not transfer artifact parent: connection reset"))
        self.assertFalse(warmup.transient_failure(
            "Compilation failure: cannot find symbol status code: 502"))
        self.assertFalse(warmup.transient_failure("Could not transfer artifact parent: status code: 404"))

    def test_captured_hosted_429_is_classified_transient(self):
        captured = (
            "Plugin org.apache.maven.plugins:maven-resources-plugin:3.5.0 or one of its "
            "dependencies could not be resolved: The following artifacts could not be "
            "resolved: org.apache.maven.plugins:maven-resources-plugin:pom:3.5.0 (absent): "
            "Could not transfer artifact "
            "org.apache.maven.plugins:maven-resources-plugin:pom:3.5.0 from/to central "
            "(https://repo.maven.apache.org/maven2): HTTP Status: 429")
        self.assertTrue(warmup.transient_failure(captured))

    def test_forced_update_flag_is_idempotent_and_skips_other_tools(self):
        updated = warmup.with_forced_update(["/tools/mvn", *OPTIONS, "-q"])
        self.assertEqual(updated[:3], ["/tools/mvn", "-U", *OPTIONS[:1]])
        self.assertEqual(warmup.with_forced_update(updated), updated)
        self.assertEqual(warmup.with_forced_update(["/tools/gradle", "build"]),
                         ["/tools/gradle", "build"])

    def test_maven_retry_options_are_idempotent_and_skip_other_tools(self):
        once = warmup.with_maven_options(["/tools/mvn", "-q"])
        self.assertEqual(once, ["/tools/mvn", *OPTIONS, "-q"])
        self.assertEqual(warmup.with_maven_options(once), once)
        self.assertEqual(warmup.with_maven_options(["/tools/gradle", "--offline", "build"]),
                         ["/tools/gradle", "--offline", "build"])

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
