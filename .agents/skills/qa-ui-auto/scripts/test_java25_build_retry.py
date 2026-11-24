"""Retry boundaries for the online Java 25 fixture builds."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from ci_maven_warmup import MAVEN_RETRY_OPTIONS
from qa_ui_auto.fixtures import java25_projects as projects


TRANSFER = ("Could not transfer artifact "
            "org.apache.maven.plugins:maven-resources-plugin:pom:3.5.0 "
            "from/to central (https://repo.maven.apache.org/maven2): HTTP Status: 429")


def completed(code=0, stdout="", stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class Java25BuildRetryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.command = ["mvn", "-q", "-DskipTests", "package"]

    def run_build(self, command=None, **kwargs):
        return projects._run_build(command or self.command, self.root, **kwargs)

    @patch.object(projects.time, "sleep")
    @patch.object(projects.subprocess, "run")
    def test_transient_transfer_failure_is_retried_with_maven_options(self, run, sleep):
        run.side_effect = [completed(1, stderr=TRANSFER), completed(0, "built")]
        receipt = self.run_build()
        self.assertEqual(receipt["exitCode"], 0)
        self.assertEqual(receipt["attempts"], 2)
        self.assertEqual(len(receipt["retries"]), 1)
        self.assertEqual(receipt["retries"][0]["exitCode"], 1)
        self.assertIn("-Daether.connector.http.retryHandler.count=5", receipt["command"])
        self.assertEqual(run.call_count, 2)
        first, second = (call.args[0] for call in run.call_args_list)
        self.assertNotIn("-U", first)
        self.assertIn("-U", second)
        sleep.assert_called_once_with(5.0)

    @patch.object(projects.time, "sleep")
    @patch.object(projects.subprocess, "run")
    def test_compile_error_is_fatal_on_the_first_attempt(self, run, sleep):
        run.return_value = completed(1, stderr="Compilation failure: cannot find symbol")
        with self.assertRaisesRegex(RuntimeError, "Java 25 fixture build failed"):
            self.run_build()
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()

    @patch.object(projects.time, "sleep")
    @patch.object(projects.subprocess, "run")
    def test_build_timeout_is_retried(self, run, sleep):
        run.side_effect = [subprocess.TimeoutExpired(self.command, 240, output=b"connecting"),
                           completed(0, "built")]
        receipt = self.run_build()
        self.assertEqual(receipt["attempts"], 2)
        self.assertTrue(receipt["retries"][0]["timedOut"])
        sleep.assert_called_once_with(5.0)

    @patch.object(projects.time, "sleep")
    @patch.object(projects.subprocess, "run")
    def test_persistent_transfer_failure_reports_the_attempt_count(self, run, sleep):
        run.return_value = completed(1, stderr=TRANSFER)
        with self.assertRaisesRegex(RuntimeError, r"attempts=3"):
            self.run_build()
        self.assertEqual(run.call_count, 3)
        self.assertEqual([call.args for call in sleep.call_args_list], [(5.0,), (15.0,)])

    @patch.object(projects.time, "sleep")
    @patch.object(projects.subprocess, "run")
    def test_gradle_transfer_failures_retry_without_maven_options(self, run, sleep):
        command = ["gradle", "--offline", "--no-daemon", "clean", "build"]
        run.side_effect = [completed(1, stderr="Could not resolve all files for "
                                                  "configuration ':compileClasspath'. Read timed out"),
                           completed(0, "built")]
        receipt = self.run_build(command)
        self.assertEqual(receipt["attempts"], 2)
        self.assertEqual(receipt["command"], command)
        self.assertNotIn("-Dmaven.wagon.http.retryHandler.count=5", receipt["command"])
        self.assertEqual([call.args[0] for call in run.call_args_list], [command, command])

    @unittest.skipUnless(os.name == "posix", "POSIX shell probe")
    @patch.object(projects.time, "sleep")
    def test_real_subprocess_retry_with_fake_maven(self, sleep):
        bindir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, bindir, ignore_errors=True)
        counter = bindir / "count"
        script = bindir / "mvn"
        script.write_text(
            "#!/bin/sh\n"
            f"count=$(cat {counter} 2>/dev/null || echo 0)\n"
            "count=$((count+1))\n"
            f"echo $count > {counter}\n"
            "if [ \"$count\" -eq 1 ]; then\n"
            "  echo 'Could not transfer artifact x from/to central: HTTP Status: 429' >&2\n"
            "  exit 1\n"
            "fi\n"
            "echo built\n",
            encoding="utf-8",
        )
        script.chmod(0o755)
        receipt = projects._run_build([str(script), "-q", "package"], self.root)
        self.assertEqual(receipt["exitCode"], 0)
        self.assertEqual(receipt["attempts"], 2)
        self.assertEqual(counter.read_text().strip(), "2")
        self.assertIn("-Daether.connector.http.retryHandler.count=5", receipt["command"])
        sleep.assert_called_once_with(5.0)

    @patch.object(projects.time, "sleep")
    @patch.object(projects.subprocess, "run")
    def test_exhausted_budget_does_not_retry_twice(self, run, sleep):
        run.return_value = completed(1, stderr=TRANSFER)
        with self.assertRaises(RuntimeError):
            self.run_build(budget_seconds=0.0)
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
