"""Failure evidence precedes destructive driver cleanup and never masks it."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from native_application_restart import restart_owned_application
from native_restart_failure import CLOSE_TARGET
from native_webdriver_transport import WebDriverError


class NativeRestartFailureTest(unittest.TestCase):
    def scenario(self, root):
        events = []
        error = WebDriverError("native pointer target did not become stable and hit-testable")
        session = SimpleNamespace(application=root / "app.exe", session_id="old", transport="tauri-driver",
            deadline=object(), pointer_observations_path=root / "native-pointer-clicks.jsonl", last_request={})
        session.click = Mock(side_effect=error)
        def screenshot(path):
            events.append("screenshot")
            path.write_bytes(b"fake unit snapshot")
            return str(path)
        def execute(script):
            events.append("close-target" if script == CLOSE_TARGET else "html")
            return {"hit": [{"testId": "cover"}]} if script == CLOSE_TARGET else "<html>covered</html>"
        session.screenshot = Mock(side_effect=screenshot)
        session.execute = Mock(side_effect=execute)
        session.close = Mock(side_effect=lambda: events.append("close-session"))
        driver = SimpleNamespace(proc=SimpleNamespace(pid=1), start=Mock(),
                                 stop=Mock(side_effect=lambda: events.append("stop-driver")))
        return session, driver, events, error

    def test_records_window_before_releasing_session_and_preserves_primary_error(self):
        with TemporaryDirectory() as folder, patch("native_application_restart.platform.system", return_value="Windows"):
            session, driver, events, error = self.scenario(Path(folder))
            old_deadline = session.deadline
            with self.assertRaises(WebDriverError) as raised:
                restart_owned_application(driver, session)
            self.assertIs(raised.exception, error)
            self.assertEqual(events, ["screenshot", "close-target", "html", "close-session", "stop-driver"])
            self.assertIs(session.deadline, old_deadline)
            artifacts = session.application_restart_observation["before_release_artifacts"]
            self.assertEqual(set(artifacts), {"screenshot", "close_target", "html"})
            self.assertTrue(all(Path(path).is_file() for path in artifacts.values()))
            self.assertIn('"testId": "cover"', Path(artifacts["close_target"]).read_text())
            driver.start.assert_not_called()

    def test_secondary_diagnostic_errors_do_not_skip_cleanup_or_replace_failure(self):
        with TemporaryDirectory() as folder, patch("native_application_restart.platform.system", return_value="Windows"):
            session, driver, events, error = self.scenario(Path(folder))
            session.screenshot.side_effect = OSError("snapshot unavailable")
            session.execute.side_effect = WebDriverError("diagnostics unavailable")
            with self.assertRaises(WebDriverError) as raised:
                restart_owned_application(driver, session)
            self.assertIs(raised.exception, error)
            self.assertEqual(events, ["close-session", "stop-driver"])
            self.assertEqual(len(session.application_restart_observation["diagnostic_errors"]), 3)
            driver.start.assert_not_called()
