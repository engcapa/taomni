"""Fixture ownership, including an isolated Windows process-tree lock probe."""
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from qa_ui_auto import runner
from qa_ui_auto.fixtures import Fixture
from qa_ui_auto.steps import StepError


class NativeFixtureCleanupTest(unittest.TestCase):
    def run_case(self, failure=None, setup_failure=False, cleanup_failure=False, close_failure=False,
                 second_name="second"):
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

        second = Fixture(second_name, second_setup, second_cleanup)
        fixtures = {first.name: first, second.name: second}
        case = SimpleNamespace(id="TC-FIXTURE-OWNER", title="fixture ownership", tags=[], covers=[],
                               modes=["native"], native_platforms=[], fixtures=list(fixtures),
                               timeout_sec=60, skip=None, steps=[{"wait": 0}])
        harness = MagicMock()
        harness.__enter__.return_value = harness
        session = harness.create_session.return_value
        session.console_entries.return_value = []
        def close():
            events.append("session-close")
            if close_failure:
                raise RuntimeError("owned process cleanup failed")

        session.close.side_effect = close
        with TemporaryDirectory() as directory, \
             patch("tauri_webdriver.NativeHarness", return_value=harness), \
             patch.object(runner.platform, "system", return_value="Linux"), \
             patch.object(runner, "get_fixture", side_effect=fixtures.__getitem__), \
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

    def test_updater_teardown_runs_once_after_session_even_when_step_fails(self):
        for failure in [None, StepError("original step failure")]:
            with self.subTest(failure=failure):
                events, result = self.run_case(failure, second_name="macos_updater")
                self.assertEqual(events, ["first-setup", "second-setup", "session-close",
                                          "second-cleanup", "first-cleanup"])
                self.assertEqual(result["status"], "failed" if failure else "passed")
                if failure:
                    self.assertEqual(result["failure"]["message"], "original step failure")

    def test_updater_partial_setup_is_cleaned_without_hiding_original_failure(self):
        for cleanup_failure in [False, True]:
            with self.subTest(cleanup_failure=cleanup_failure):
                events, result = self.run_case(setup_failure=True, cleanup_failure=cleanup_failure,
                                               second_name="macos_updater")
                self.assertEqual(events, ["first-setup", "second-cleanup", "first-cleanup"])
                self.assertEqual(result["status"], "failed")
                self.assertIn("setup failed", result["failure"]["message"])
                if cleanup_failure:
                    self.assertEqual(result["fixture_cleanup_errors"], [
                        {"fixture": "macos_updater", "message": "cleanup failed"},
                    ])

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

    def test_session_cleanup_failure_is_reported_without_hiding_step_failure(self):
        for failure in [None, StepError("original step failure")]:
            with self.subTest(failure=failure):
                events, result = self.run_case(failure, close_failure=True)
                self.assertEqual(events[-2:], ["second-cleanup", "first-cleanup"])
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["session_cleanup_error"], "owned process cleanup failed")
                self.assertEqual(result["failure"]["message"],
                                 "original step failure" if failure else "owned process cleanup failed")

    @unittest.skipUnless(sys.platform == "win32", "Windows file locks and process trees")
    def test_windows_session_close_releases_child_file_lock_and_leaves_unowned_process(self):
        from tauri_webdriver import TauriDriverProcess

        child_code = (
            "import ctypes, pathlib, sys, time; "
            "api = ctypes.WinDLL('kernel32', use_last_error=True); "
            "api.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, "
            "ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]; "
            "api.CreateFileW.restype = ctypes.c_void_p; "
            "handle = api.CreateFileW(sys.argv[1], 0x40000000, 0, None, 2, 0, None); "
            "assert handle != ctypes.c_void_p(-1).value; "
            "pathlib.Path(sys.argv[2]).write_text('locked'); time.sleep(60)"
        )
        with TemporaryDirectory() as directory:
            root = Path(directory)
            locked, ready = root / "history.db", root / "ready"
            parent_code = (
                "import subprocess, sys, time; "
                f"subprocess.Popen([sys.executable, '-c', {child_code!r}, {str(locked)!r}, {str(ready)!r}], "
                "creationflags=subprocess.CREATE_NO_WINDOW); time.sleep(60)"
            )
            driver = TauriDriverProcess({}, root)
            driver.proc = subprocess.Popen([sys.executable, "-c", parent_code],
                                           creationflags=subprocess.CREATE_NO_WINDOW)
            owned = driver.proc
            unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                                         creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                end = time.monotonic() + 10
                while not ready.exists() and time.monotonic() < end:
                    time.sleep(0.05)
                self.assertTrue(ready.exists(), "owned child did not acquire the test lock")
                with self.assertRaises(PermissionError):
                    locked.unlink()
                driver.mark_session_closed()
                locked.unlink()
                self.assertIsNotNone(owned.poll())
                self.assertIsNone(unrelated.poll())
            finally:
                if owned.poll() is None:
                    subprocess.run(["taskkill", "/PID", str(owned.pid), "/T", "/F"],
                                   capture_output=True, timeout=20)
                    owned.wait(timeout=5)
                unrelated.terminate()
                unrelated.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
