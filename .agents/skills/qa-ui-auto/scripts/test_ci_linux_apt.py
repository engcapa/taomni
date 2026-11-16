"""Unit-test the apt recipe with shell functions; never run sudo/apt/network."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


RECIPE = Path(__file__).with_name("ci_linux_apt.sh")


class AptRecoveryTests(unittest.TestCase):
    def recipe(self, first, second=0, update=0):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "calls.tsv"
            script = r'''
set -euo pipefail
qa_apt_attempts=0
sudo() {
  printf '%s\t' "$@" >> "$QA_APT_TEST_LOG"
  printf '\n' >> "$QA_APT_TEST_LOG"
  if [[ " $* " == *" update "* ]]; then return "$QA_APT_UPDATE_STATUS"; fi
  qa_apt_attempts=$((qa_apt_attempts + 1))
  if [[ "$qa_apt_attempts" == 1 ]]; then return "$QA_APT_FIRST_STATUS"; fi
  return "$QA_APT_SECOND_STATUS"
}
'''
            script += "source " + shlex.quote(str(RECIPE)) + "\n"
            script += "install_packages libwebkit2gtk-4.1-dev libgstreamer-gl1.0-0\n"
            env = dict(os.environ, QA_APT_TEST_LOG=str(log), QA_APT_FIRST_STATUS=str(first),
                       QA_APT_SECOND_STATUS=str(second), QA_APT_UPDATE_STATUS=str(update))
            result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)
            calls = [line.rstrip("\t").split("\t") for line in log.read_text().splitlines()]
            return result, calls

    def test_successful_install_does_not_refresh_or_repeat(self):
        result, calls = self.recipe(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][-2:], ["libwebkit2gtk-4.1-dev", "libgstreamer-gl1.0-0"])
        self.assertIn("--no-install-recommends", calls[0])

    def test_stale_index_failure_refreshes_once_then_retries_the_exact_packages(self):
        result, calls = self.recipe(100)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1][-1], "update")
        self.assertEqual(calls[0], calls[2])

    def test_repeated_failure_blocks_the_job_without_another_refresh(self):
        result, calls = self.recipe(100, second=100)
        self.assertEqual(result.returncode, 100)
        self.assertEqual(len(calls), 3)

    def test_refresh_failure_blocks_retry_and_preserves_its_error(self):
        result, calls = self.recipe(100, update=42)
        self.assertEqual(result.returncode, 42)
        self.assertEqual(len(calls), 2)

    def test_non_apt_error_does_not_start_an_index_refresh(self):
        result, calls = self.recipe(130)
        self.assertEqual(result.returncode, 130)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
