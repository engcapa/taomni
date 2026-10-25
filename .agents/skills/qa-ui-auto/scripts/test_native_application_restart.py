from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from native_application_restart import close_application_window, restart_owned_application
from native_webdriver_transport import WebDriverError


class NativeApplicationRestartTest(unittest.TestCase):
    def scenario(self):
        events = []
        deadline = SimpleNamespace(remaining=Mock(return_value=20))
        session = SimpleNamespace(application=Path("qa-app"), session_id="old", deadline=deadline, transport="tauri-driver")
        session.click = Mock(side_effect=lambda selector: events.append("window-close"))
        session.execute = Mock(side_effect=WebDriverError("no such window"))
        def close():
            events.append("close")
            session.deadline = "cleanup-budget"
            session.session_id = None
        session.close = Mock(side_effect=close)
        def start():
            self.assertIs(session.deadline, deadline)
            events.append("start-session")
            session.session_id = "new"
        session.start = Mock(side_effect=start)
        driver = SimpleNamespace(stop=Mock(side_effect=lambda: events.append("stop-owner")),
                                 start=Mock(side_effect=lambda: events.append("start-owner")),
                                 mark_session_closed=Mock(), _restart_required=True,
                                 host="127.0.0.1", port=0, native_port=0)
        return session, driver, events

    def test_restarts_the_owned_process_without_resetting_profile_and_keeps_case_budget(self):
        session, driver, events = self.scenario()
        result = restart_owned_application(driver, session)
        self.assertEqual(events, ["window-close", "close", "stop-owner", "start-owner", "start-session"])
        self.assertIs(session._on_close, driver.mark_session_closed)
        self.assertFalse(driver._restart_required)
        self.assertEqual((result["before_session"], result["after_session"]), ("old", "new"))
        self.assertEqual(result["shutdown"], "application-window-close")

    def test_waits_for_graceful_window_close_before_releasing_profile(self):
        session, driver, _ = self.scenario()
        session.execute.side_effect = [None, WebDriverError("Browsing context not found")]
        with patch("native_application_restart.time.sleep"):
            restart_owned_application(driver, session)
        self.assertEqual(session.execute.call_count, 2)

    def test_webkit_terminated_reply_after_window_close_is_expected(self):
        session, driver, _ = self.scenario()
        session.click.side_effect = WebDriverError("Session terminated without a reply")
        result = restart_owned_application(driver, session)
        self.assertEqual(result["shutdown"], "application-window-close")

    def test_intercepted_titlebar_click_dispatches_the_same_production_handler(self):
        session, driver, _ = self.scenario()
        session.click.side_effect = WebDriverError("element click intercepted")
        session.execute.side_effect = [True, WebDriverError("no such window")]
        result = restart_owned_application(driver, session)
        self.assertEqual(result["shutdown"], "application-window-close")
        session.execute.assert_any_call(
            'const button = document.querySelector("[data-testid=window-close]");'
            'if (!button) throw new Error("QA application close control is missing");'
            'button.click(); return true;'
        )

    def test_unexpected_exit_dialog_is_not_automatically_confirmed(self):
        session, driver, _ = self.scenario()
        session.execute.side_effect = None
        session.execute.return_value = "Exit requires confirmation"
        with self.assertRaisesRegex(RuntimeError, "confirmation"):
            restart_owned_application(driver, session)
        driver.start.assert_not_called()

    def test_intercepted_close_can_destroy_its_context_before_script_acknowledgement(self):
        session, driver, _ = self.scenario()
        session.click.side_effect = WebDriverError("element click intercepted")
        session.execute.side_effect = WebDriverError("invalid session id: session deleted because of page crash or hang")
        result = restart_owned_application(driver, session)
        self.assertEqual(result["after_session"], "new")
        self.assertEqual(session.execute.call_count, 1)

    def test_unrelated_transport_failure_does_not_claim_a_graceful_close(self):
        session, _, _ = self.scenario()
        session.execute.side_effect = WebDriverError("evaluation timed out")
        with self.assertRaisesRegex(WebDriverError, "timed out"):
            close_application_window(session)

    def test_uncertain_close_releases_owner_and_never_starts_a_second_app(self):
        session, driver, _ = self.scenario()
        session.close.side_effect = RuntimeError("uncertain close")
        with self.assertRaisesRegex(RuntimeError, "uncertain close"):
            restart_owned_application(driver, session)
        driver.stop.assert_called_once()
        driver.start.assert_not_called()

    def test_failed_launch_stays_failed(self):
        session, driver, _ = self.scenario()
        session.start.side_effect = RuntimeError("launch failed")
        with self.assertRaisesRegex(RuntimeError, "launch failed"):
            restart_owned_application(driver, session)

    def test_reused_session_cannot_claim_a_cold_start(self):
        session, driver, _ = self.scenario()
        session.start.side_effect = lambda: setattr(session, "session_id", "old")
        with self.assertRaisesRegex(RuntimeError, "new native session"):
            restart_owned_application(driver, session)


if __name__ == "__main__":
    unittest.main()
