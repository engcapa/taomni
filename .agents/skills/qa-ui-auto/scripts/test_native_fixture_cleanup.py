"""Runner fixture ownership; all driver and operating-system operations mocked."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from qa_ui_auto import runner
from qa_ui_auto.fixtures import Fixture
from qa_ui_auto.steps import StepError


class NativeFixtureCleanupTest(unittest.TestCase):
    def run_case(self, failure=None, setup_failure=False, cleanup_failure=False):
        events = []
        first = Fixture("first", lambda ctx: events.append("first-setup"),
                        lambda ctx: events.append("first-cleanup"))

        def second_setup(ctx):
            if setup_failure:
                raise RuntimeError("setup failed")
            events.append("second-setup")

        def second_cleanup(ctx):
            events.append("second-cleanup")
            if cleanup_failure:
                raise RuntimeError("cleanup failed")

        second = Fixture("second", second_setup, second_cleanup)
        case = SimpleNamespace(id="TC-FIXTURE-OWNER", title="fixture ownership", tags=[], covers=[],
                               modes=["native"], native_platforms=[], fixtures=["first", "second"],
                               timeout_sec=60, skip=None, steps=[{"wait": 0}])
        harness = MagicMock()
        harness.__enter__.return_value = harness
        session = harness.create_session.return_value
        session.console_entries.return_value = []
        session.close.side_effect = lambda: events.append("session-close")
        with TemporaryDirectory() as directory, \
             patch("tauri_webdriver.NativeHarness", return_value=harness), \
             patch.object(runner.platform, "system", return_value="Linux"), \
             patch.object(runner, "get_fixture", side_effect=[first, second]), \
             patch("qa_ui_auto.native_steps.run_native_step", side_effect=failure), \
             patch.object(runner, "_capture_native_failure", return_value={}), \
             patch("qa_ui_auto.native_diagnostics.collect"), \
             patch.object(runner, "_jdtls_pids", return_value=set()), \
             patch.object(runner, "_matching_pids", return_value=set()), \
             patch.object(runner, "_reap_orphaned_jdtls", return_value={}), \
             patch.object(runner, "_reap_lingering_qa_apps", return_value={}):
            results = runner._native_run([case], {"app": {"mode": "native"}}, {}, Path(directory), False)
        return events, results[0]

    def test_success_and_step_failure_restore_every_fixture_after_session_close(self):
        for failure in [None, StepError("original step failure")]:
            with self.subTest(failure=failure):
                events, result = self.run_case(failure)
                self.assertEqual(events, ["first-setup", "second-setup", "session-close",
                                          "second-cleanup", "first-cleanup"])
                self.assertEqual(result["status"], "failed" if failure else "passed")
                if failure:
                    self.assertEqual(result["failure"]["message"], "original step failure")

    def test_later_setup_failure_restores_already_created_fixtures(self):
        events, result = self.run_case(setup_failure=True)
        self.assertEqual(events, ["first-setup", "first-cleanup"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("setup failed", result["failure"]["message"])

    def test_cleanup_failure_continues_restoration_and_preserves_original_failure(self):
        for failure in [None, StepError("original step failure")]:
            with self.subTest(failure=failure):
                events, result = self.run_case(failure, cleanup_failure=True)
                self.assertEqual(events[-2:], ["second-cleanup", "first-cleanup"])
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["fixture_cleanup_errors"][0]["fixture"], "second")
                if failure:
                    self.assertEqual(result["failure"]["message"], "original step failure")
                else:
                    self.assertEqual(result["failure"]["verb"], "<fixture-cleanup>")


if __name__ == "__main__":
    unittest.main()
