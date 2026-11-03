from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from native_application_restart import close_application_window, restart_owned_application
from native_webdriver_transport import WebDriverError


class NativeApplicationRestartTest(unittest.TestCase):
    def setUp(self):
        self.shutdown = patch("native_application_restart.wait_for_application_shutdown", return_value={"process_ids": []}).start()
        self.x11 = patch("native_application_restart.uses_x11_window_close", return_value=False).start()
        self.addCleanup(patch.stopall)

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
                                 host="127.0.0.1", port=0, native_port=0, proc=SimpleNamespace(pid=100))
        def launch():
            events.append("start-owner")
            driver.proc = SimpleNamespace(pid=200, poll=Mock(return_value=None))
        driver.start.side_effect = launch
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

    def test_macos_uses_its_owned_native_close_button_and_keeps_the_os_observation(self):
        session, driver, events = self.scenario()
        session.transport = "macOS WKWebView bridge"
        observed = {"application": str(session.application.resolve()), "pid": 123, "transport": "macOS native close button"}
        with patch("native_application_restart.close_macos_application_window", return_value=observed) as close:
            result = restart_owned_application(driver, session)
        close.assert_called_once_with(session.application)
        session.click.assert_not_called()
        self.assertEqual(result["native_close"], observed)
        self.assertEqual(events, ["close", "stop-owner", "start-owner", "start-session"])

    def test_macos_native_close_failure_never_starts_a_second_application(self):
        session, driver, _ = self.scenario()
        session.transport = "macOS WKWebView bridge"
        with patch("native_application_restart.close_macos_application_window", side_effect=WebDriverError("no owned window")):
            with self.assertRaisesRegex(WebDriverError, "no owned window"):
                restart_owned_application(driver, session)
        driver.stop.assert_called_once()
        driver.start.assert_not_called()

    def test_macos_constant_protocol_session_requires_a_different_owned_process(self):
        session, driver, _ = self.scenario()
        session.transport = "macOS WKWebView bridge"
        session.start.side_effect = lambda: setattr(session, "session_id", "old")
        with patch("native_application_restart.close_macos_application_window", return_value={"pid": 100}):
            result = restart_owned_application(driver, session)
        self.assertEqual((result["before_owner_pid"], result["after_owner_pid"]), (100, 200))

    def test_macos_reused_owner_cannot_claim_a_cold_start(self):
        session, driver, _ = self.scenario()
        session.transport = "macOS WKWebView bridge"
        driver.start.side_effect = None
        with patch("native_application_restart.close_macos_application_window", return_value={"pid": 100}):
            with self.assertRaisesRegex(RuntimeError, "new owned macOS process"):
                restart_owned_application(driver, session)

    def test_macos_broken_pipe_after_native_close_requires_normal_process_exit(self):
        session, driver, _ = self.scenario()
        session.transport = "macOS WKWebView bridge"
        session.execute.side_effect = BrokenPipeError("bridge closed with the app")
        with patch("native_application_restart.close_macos_application_window", return_value={"pid": 100}):
            result = restart_owned_application(driver, session)
        self.shutdown.assert_called_once_with(driver, session, {})
        self.assertEqual(result["native_close"], {"pid": 100})
        self.assertEqual(result["after_owner_pid"], 200)

    def test_broken_pipe_without_an_observed_native_close_stays_failed(self):
        session, driver, _ = self.scenario()
        session.execute.side_effect = BrokenPipeError("unverified transport loss")
        with self.assertRaisesRegex(BrokenPipeError, "unverified"):
            restart_owned_application(driver, session)
        driver.start.assert_not_called()

    def test_broken_pipe_after_native_close_never_hides_an_abnormal_exit(self):
        session, driver, _ = self.scenario()
        session.transport = "macOS WKWebView bridge"
        session.execute.side_effect = BrokenPipeError("bridge closed")
        self.shutdown.side_effect = RuntimeError("QA application did not exit normally (exit 9)")
        with patch("native_application_restart.close_macos_application_window", return_value={"pid": 100}):
            with self.assertRaisesRegex(RuntimeError, "exit 9"):
                restart_owned_application(driver, session)
        driver.start.assert_not_called()

    def test_cleanup_failure_preserves_the_original_close_error(self):
        session, driver, _ = self.scenario()
        session.click.side_effect = BrokenPipeError("original close failure")
        session.close.side_effect = ConnectionRefusedError("cleanup connection refused")
        with self.assertRaisesRegex(BrokenPipeError, "original close failure"):
            restart_owned_application(driver, session)
        self.assertEqual(session.application_restart_observation["cleanup_errors"], ["cleanup connection refused"])
        driver.stop.assert_called_once()
        driver.start.assert_not_called()

    def test_x11_close_requires_native_surface_disappearance_and_storage_exit(self):
        session, driver, events = self.scenario()
        self.x11.return_value = True
        observed = {"transport": "X11 window-manager close", "pid": 123,
                    "window_id": "0x123", "window_closed": False}
        session.execute.side_effect = WebDriverError('HTTP 500: {"value":{"error":"unknown error","message":""}}')
        with patch("native_application_restart.close_x11_application_window", return_value=observed) as close, \
                patch("native_application_restart.x11_window_closed", side_effect=[False, True]) as closed, \
                patch("native_application_restart.time.sleep"):
            result = restart_owned_application(driver, session)
        close.assert_called_once_with(session.application, {})
        session.click.assert_not_called()
        self.assertEqual(closed.call_count, 2)
        self.shutdown.assert_called_once_with(driver, session, {})
        self.assertIn("HTTP 500", observed["webdriver_close_error"])
        self.assertEqual(result["native_close"], observed)
        self.assertEqual(events, ["close", "stop-owner", "start-owner", "start-session"])

    def test_x11_unknown_error_with_existing_native_window_stays_failed(self):
        session, driver, _ = self.scenario()
        self.x11.return_value = True
        session.execute.side_effect = WebDriverError("HTTP 500: unknown error")
        observed = {"transport": "X11 window-manager close", "window_id": "0x123"}
        with patch("native_application_restart.close_x11_application_window", return_value=observed), \
                patch("native_application_restart.x11_window_closed", return_value=False), \
                patch("native_application_restart.time.monotonic", side_effect=[0, 0, 16]), \
                patch("native_application_restart.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "did not close"):
                restart_owned_application(driver, session)
        self.shutdown.assert_not_called()
        driver.start.assert_not_called()
        self.assertIn("HTTP 500", session.application_restart_observation["native_close"]["webdriver_close_error"])

    def test_x11_confirmation_is_not_bypassed_and_uncertain_storage_is_not_killed_for_pass(self):
        for dialog in (True, False):
            with self.subTest(dialog=dialog):
                session, driver, _ = self.scenario()
                self.x11.return_value = True
                session.execute.side_effect = None
                session.execute.return_value = "Exit confirmation" if dialog else None
                self.shutdown.reset_mock()
                self.shutdown.side_effect = RuntimeError("storage processes did not exit normally")
                observed = {"transport": "X11 window-manager close", "window_id": "0x123"}
                with patch("native_application_restart.close_x11_application_window", return_value=observed), \
                        patch("native_application_restart.x11_window_closed", return_value=not dialog):
                    with self.assertRaisesRegex(RuntimeError, "confirmation" if dialog else "storage processes"):
                        restart_owned_application(driver, session)
                driver.start.assert_not_called()
                session.click.assert_not_called()

    def test_x11_close_identity_failure_never_dispatches_a_fallback_click(self):
        session, driver, _ = self.scenario()
        self.x11.return_value = True
        with patch("native_application_restart.close_x11_application_window",
                   side_effect=WebDriverError("No unique managed X11 window")):
            with self.assertRaisesRegex(WebDriverError, "No unique"):
                restart_owned_application(driver, session)
        session.click.assert_not_called()
        session.execute.assert_not_called()
        self.shutdown.assert_not_called()
        driver.start.assert_not_called()

    def test_reused_session_cannot_claim_a_cold_start(self):
        session, driver, _ = self.scenario()
        session.start.side_effect = lambda: setattr(session, "session_id", "old")
        with self.assertRaisesRegex(RuntimeError, "new native session"):
            restart_owned_application(driver, session)


if __name__ == "__main__":
    unittest.main()
