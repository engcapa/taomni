import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import jsonschema
import yaml

from native_application_restart import (EXIT_DIALOG_OBSERVATION, bind_application_restarter,
                                        close_application_window, restart_owned_application)
from native_webdriver_transport import WebDriverError
from qa_ui_auto.native_steps import run_native_step
from qa_ui_auto.steps import StepError
from qa_ui_auto.testcase import TESTCASE_SCHEMA_PATH, load_case


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

    def confirmation_scenario(self):
        session, driver, events = self.scenario()
        expected = {"title": "Exit", "message": "There is 1 open tab. Exit Taomni and close it?", "confirm_label": "Exit"}
        dialog = {**expected, "count": 1, "confirm_count": 1, "confirm_visible": True, "confirm_enabled": True}
        return session, driver, events, expected, dialog

    def test_expected_exit_confirmation_is_clicked_once_before_normal_shutdown(self):
        session, driver, events, expected, dialog = self.confirmation_scenario()
        session.execute.side_effect = [None, None, dialog, WebDriverError("no such window")]
        session.click.side_effect = lambda selector: events.append(selector)
        with patch("native_application_restart.time.sleep"):
            result = restart_owned_application(driver, session, expect_exit_confirmation=expected)
        self.assertEqual(events, ['[data-testid="window-close"]',
                                  '[data-testid="confirm-dialog"] [data-testid="confirm-dialog-confirm"]',
                                  "close", "stop-owner", "start-owner", "start-session"])
        confirmation = result["exit_confirmation"]
        self.assertEqual(confirmation["observed"], dialog)
        self.assertTrue(confirmation["click_attempted"])
        self.assertTrue(confirmation["click_returned"])
        self.assertTrue(confirmation["closed_after_confirmation"])
        self.assertEqual(confirmation["status"], "verified")
        self.shutdown.assert_called_once_with(driver, session, {})

    def test_binding_forwards_optional_confirmation_and_preserves_no_arg_restart(self):
        session, driver, _, expected, _ = self.confirmation_scenario()
        with patch("native_application_restart.restart_owned_application", return_value={}) as restart:
            bind_application_restarter(driver, session)
            session.application_restarter()
            restart.assert_called_once_with(driver, session)
            restart.reset_mock()
            session.application_restarter(expect_exit_confirmation=expected)
            restart.assert_called_once_with(driver, session, expect_exit_confirmation=expected)

    def test_expected_confirmation_must_be_observed_not_silently_skipped(self):
        for native in (False, True):
            with self.subTest(native_x11=native):
                session, driver, _, expected, _ = self.confirmation_scenario()
                self.x11.return_value = native
                session.execute.side_effect = [None, WebDriverError("no such window")]
                observed = {"transport": "X11 window-manager close", "window_id": "0x123"}
                self.shutdown.reset_mock()
                with patch("native_application_restart.close_x11_application_window", return_value=observed), \
                        patch("native_application_restart.x11_window_closed", return_value=True):
                    with self.assertRaisesRegex(RuntimeError, "without the expected"):
                        restart_owned_application(driver, session, expect_exit_confirmation=expected)
                self.shutdown.assert_not_called()
                driver.start.assert_not_called()
                self.assertFalse(session.application_restart_observation["exit_confirmation"]["click_attempted"])

    def test_preexisting_dialog_never_gets_approved_by_an_expected_restart(self):
        session, driver, _, expected, dialog = self.confirmation_scenario()
        session.execute.side_effect = [dialog]
        with self.assertRaisesRegex(RuntimeError, "already open"):
            restart_owned_application(driver, session, expect_exit_confirmation=expected)
        session.click.assert_not_called()
        driver.start.assert_not_called()

    def test_mismatched_hidden_disabled_or_ambiguous_confirmation_never_gets_clicked(self):
        for field, value in [("title", "Save backup?"), ("message", "Cleanup failed"),
                             ("confirm_label", "Retry"), ("confirm_visible", False),
                             ("confirm_enabled", False), ("count", 2), ("confirm_count", 2)]:
            with self.subTest(field=field):
                session, driver, _, expected, dialog = self.confirmation_scenario()
                dialog[field] = value
                session.execute.side_effect = [None, dialog]
                with self.assertRaisesRegex(RuntimeError, "did not match|visible enabled"):
                    restart_owned_application(driver, session, expect_exit_confirmation=expected)
                session.click.assert_called_once_with('[data-testid="window-close"]')
                driver.start.assert_not_called()

    def test_confirmation_click_interception_and_uncertain_transport_are_not_retried(self):
        for error in (WebDriverError("element click intercepted"), WebDriverError("HTTP 500: unknown error")):
            with self.subTest(error=error):
                session, driver, _, expected, dialog = self.confirmation_scenario()
                session.execute.side_effect = [None, dialog]
                session.click.side_effect = [None, error]
                with self.assertRaisesRegex(WebDriverError, "intercepted|HTTP 500"):
                    restart_owned_application(driver, session, expect_exit_confirmation=expected)
                self.assertEqual(session.click.call_count, 2)
                self.assertEqual(session.execute.call_count, 2)
                receipt = session.application_restart_observation["exit_confirmation"]
                self.assertTrue(receipt["click_attempted"])
                self.assertFalse(receipt["click_returned"])
                self.assertIn(str(error), receipt["click_error"])
                driver.start.assert_not_called()

    def test_confirm_preparation_or_unsent_action_loss_is_not_evidence_that_input_was_sent(self):
        for path, phase in (("element", "response_headers"), ("actions", "prepare"), ("actions", "send_request")):
            with self.subTest(path=path, phase=phase):
                session, driver, _, expected, dialog = self.confirmation_scenario()
                session.execute.side_effect = [None, dialog]
                session.click.side_effect = [None, WebDriverError("no such window")]
                session.last_request = {"method": "POST", "path": f"/session/old/{path}", "phase": phase}
                with self.assertRaisesRegex(WebDriverError, "no such window"):
                    restart_owned_application(driver, session, expect_exit_confirmation=expected)
                self.shutdown.assert_not_called()
                driver.start.assert_not_called()
                self.assertFalse(session.application_restart_observation["exit_confirmation"]["closed_after_confirmation"])

    def test_confirm_click_can_close_context_before_reply_but_still_needs_normal_shutdown(self):
        for method, phase in (("POST", "response_headers"), ("DELETE", "send_request")):
            with self.subTest(method=method, phase=phase):
                session, driver, _, expected, dialog = self.confirmation_scenario()
                session.execute.side_effect = [None, dialog, WebDriverError("no such window")]
                session.click.side_effect = [None, WebDriverError("Session terminated without a reply")]
                session.last_request = {"method": method, "path": "/session/old/actions", "phase": phase}
                self.shutdown.reset_mock()
                with patch("native_application_restart.time.sleep"):
                    result = restart_owned_application(driver, session, expect_exit_confirmation=expected)
                self.assertEqual(session.click.call_count, 2)
                self.shutdown.assert_called_once_with(driver, session, {})
                self.assertFalse(result["exit_confirmation"]["click_returned"])
                self.assertEqual(result["exit_confirmation"]["status"], "verified")

    def test_confirmed_exit_retains_the_original_case_deadline_through_dialog_wait(self):
        session, driver, _, expected, dialog = self.confirmation_scenario()
        session.execute.side_effect = [None, dialog, None]
        session.deadline.remaining.side_effect = [5, TimeoutError("case execution deadline exceeded")]
        with patch("native_application_restart.time.sleep"):
            with self.assertRaisesRegex(TimeoutError, "deadline exceeded"):
                restart_owned_application(driver, session, expect_exit_confirmation=expected)
        self.assertEqual(session.click.call_count, 2)
        self.shutdown.assert_not_called()
        driver.start.assert_not_called()

    def test_confirmation_does_not_approve_a_replacement_or_reappearing_dialog(self):
        for replacement in (True, False):
            with self.subTest(replacement=replacement):
                session, driver, _, expected, dialog = self.confirmation_scenario()
                changed = {**dialog, "message": "Backup settings could not be saved"} if replacement else dialog
                session.execute.side_effect = [None, dialog, changed] if replacement else [None, dialog, None, changed]
                with patch("native_application_restart.time.sleep"), self.assertRaisesRegex(RuntimeError, "another confirmation"):
                    restart_owned_application(driver, session, expect_exit_confirmation=expected)
                self.assertEqual(session.click.call_count, 2)
                driver.start.assert_not_called()

    def test_a_slow_dialog_commit_is_only_observed_and_never_reclicked(self):
        session, driver, _, expected, dialog = self.confirmation_scenario()
        session.execute.side_effect = [None, dialog, dialog, None, WebDriverError("no such window")]
        with patch("native_application_restart.time.sleep"):
            result = restart_owned_application(driver, session, expect_exit_confirmation=expected)
        self.assertEqual(session.click.call_count, 2)
        self.assertTrue(result["exit_confirmation"]["dialog_dismissed"])

    def test_click_without_closing_the_app_is_not_a_successful_restart(self):
        session, driver, _, expected, dialog = self.confirmation_scenario()
        session.execute.side_effect = [None, dialog]
        with patch("native_application_restart.time.monotonic", side_effect=[0, 0, 16]), \
                patch("native_application_restart.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "did not close"):
                restart_owned_application(driver, session, expect_exit_confirmation=expected)
        self.assertEqual(session.click.call_count, 2)
        self.shutdown.assert_not_called()
        driver.start.assert_not_called()

    def test_confirmation_never_converts_failed_storage_shutdown_or_reused_session_into_success(self):
        for failure in ("shutdown", "session"):
            with self.subTest(failure=failure):
                session, driver, _, expected, dialog = self.confirmation_scenario()
                session.execute.side_effect = [None, dialog, WebDriverError("no such window")]
                self.shutdown.side_effect = RuntimeError("storage did not exit normally") if failure == "shutdown" else None
                if failure == "session":
                    session.start.side_effect = lambda: setattr(session, "session_id", "old")
                with patch("native_application_restart.time.sleep"):
                    with self.assertRaisesRegex(RuntimeError, "storage|new native session"):
                        restart_owned_application(driver, session, expect_exit_confirmation=expected)
                if failure == "shutdown":
                    driver.start.assert_not_called()
                self.assertNotEqual(session.application_restart_observation["exit_confirmation"]["status"], "verified")

    def test_x11_confirmation_keeps_native_close_and_shutdown_evidence(self):
        session, driver, _, expected, dialog = self.confirmation_scenario()
        self.x11.return_value = True
        observed = {"transport": "X11 window-manager close", "window_id": "0x123"}
        session.execute.side_effect = [None, dialog]
        with patch("native_application_restart.close_x11_application_window", return_value=observed) as close, \
                patch("native_application_restart.x11_window_closed", side_effect=[False, True]), \
                patch("native_application_restart.time.sleep"):
            result = restart_owned_application(driver, session, expect_exit_confirmation=expected)
        close.assert_called_once_with(session.application, {})
        session.click.assert_called_once_with('[data-testid="confirm-dialog"] [data-testid="confirm-dialog-confirm"]')
        self.shutdown.assert_called_once_with(driver, session, {})
        self.assertEqual(result["native_close"], observed)
        self.assertEqual(result["exit_confirmation"]["status"], "verified")

    def test_macos_confirmation_still_requires_normal_exit_and_new_owned_process(self):
        session, driver, _, expected, dialog = self.confirmation_scenario()
        session.transport = "macOS WKWebView bridge"
        session.execute.side_effect = [None, dialog, BrokenPipeError("bridge closed with app")]
        with patch("native_application_restart.close_macos_application_window", return_value={"pid": 100}), \
                patch("native_application_restart.time.sleep"):
            result = restart_owned_application(driver, session, expect_exit_confirmation=expected)
        session.click.assert_called_once_with('[data-testid="confirm-dialog"] [data-testid="confirm-dialog-confirm"]')
        self.shutdown.assert_called_once_with(driver, session, {})
        self.assertEqual((result["before_owner_pid"], result["after_owner_pid"]), (100, 200))
        self.assertEqual(result["exit_confirmation"]["status"], "verified")

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

    def test_intercepted_titlebar_click_never_dispatches_a_synthetic_fallback(self):
        session, driver, _ = self.scenario()
        session.click.side_effect = WebDriverError("element click intercepted")
        with self.assertRaisesRegex(WebDriverError, "intercepted"):
            restart_owned_application(driver, session)
        session.click.assert_called_once_with('[data-testid="window-close"]')
        session.execute.assert_not_called()
        self.shutdown.assert_not_called()
        driver.start.assert_not_called()

    def test_unexpected_exit_dialog_is_not_automatically_confirmed(self):
        session, driver, _ = self.scenario()
        session.execute.side_effect = None
        session.execute.return_value = "Exit requires confirmation"
        with self.assertRaisesRegex(RuntimeError, "confirmation"):
            restart_owned_application(driver, session)
        driver.start.assert_not_called()

    def test_intercepted_close_never_uses_a_later_context_error_as_success(self):
        session, driver, _ = self.scenario()
        session.click.side_effect = WebDriverError("element click intercepted")
        session.execute.side_effect = WebDriverError("invalid session id: session deleted because of page crash or hang")
        with self.assertRaisesRegex(WebDriverError, "intercepted"):
            restart_owned_application(driver, session)
        session.execute.assert_not_called()
        driver.start.assert_not_called()

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


class RestartVerbContractTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.folder = Path(directory.name)
        self.expected = {"title": "Exit", "message": "There is 1 open tab. Exit Taomni and close it?", "confirm_label": "Exit"}
        self.restart = Mock(return_value={"before_session": "old", "after_session": "new", "profile_retained": True})
        self.session = SimpleNamespace(application_restarter=self.restart, last_request={})
        self.ctx = SimpleNamespace(session=self.session, case_dir=self.folder)

    def receipts(self):
        return [json.loads(line) for line in (self.folder / "native-application-restarts.jsonl").read_text().splitlines()]

    def test_null_calls_legacy_launcher_without_arguments_and_writes_receipt(self):
        summary = run_native_step(self.ctx, "native_restart_app", None)
        self.restart.assert_called_once_with()
        self.assertEqual(self.receipts(), [self.restart.return_value])
        self.assertIn("same isolated profile", summary)

    def test_opt_in_forwards_exact_expectation_and_retains_confirmation_receipt(self):
        confirmation = {"expected": self.expected, "observed": self.expected, "status": "verified", "click_attempted": True}
        self.restart.return_value["exit_confirmation"] = confirmation
        run_native_step(self.ctx, "native_restart_app", {"expect_exit_confirmation": self.expected})
        self.restart.assert_called_once_with(expect_exit_confirmation=self.expected)
        self.assertEqual(self.receipts()[0]["exit_confirmation"], confirmation)

    def test_failed_restart_retains_confirm_input_and_primary_error_without_claiming_success(self):
        observed = {"title": "Exit", "message": "Unexpected open tabs", "confirm_label": "Exit"}
        self.session.application_restart_observation = {
            "stage": "release-owner", "error_stage": "close-window",
            "exit_confirmation": {"expected": self.expected, "observed": observed,
                                  "click_attempted": False, "status": "waiting"},
        }
        self.session.last_request = {"method": "POST", "phase": "complete"}
        error = RuntimeError("confirmation did not match")
        self.restart.side_effect = error
        with self.assertRaisesRegex(RuntimeError, "did not match") as raised:
            run_native_step(self.ctx, "native_restart_app", {"expect_exit_confirmation": self.expected})
        self.assertIs(raised.exception, error)
        receipt = self.receipts()[0]
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt["error_stage"], "close-window")
        self.assertEqual(receipt["exit_confirmation"]["observed"], observed)
        self.assertFalse(receipt["exit_confirmation"]["click_attempted"])
        self.assertEqual(receipt["last_request"], self.session.last_request)

    def test_schema_and_runtime_accept_only_null_or_complete_explicit_confirmation(self):
        schema = json.loads(TESTCASE_SCHEMA_PATH.read_text(encoding="utf-8"))
        validator = jsonschema.Draft202012Validator({
            "$ref": "#/$defs/step/properties/native_restart_app", "$defs": schema["$defs"],
        })
        valid = [None, {"expect_exit_confirmation": self.expected}]
        invalid = [True, False, [], "confirm", {}, {"expect_exit_confirmation": True},
                   {"expect_exit_confirmation": None}, {"expect_exit_confirmation": {}},
                   {"expect_exit_confirmation": self.expected, "force": True}]
        for field in self.expected:
            for value in (None, 1, "", " \n\t"):
                invalid.append({"expect_exit_confirmation": {**self.expected, field: value}})
            invalid.append({"expect_exit_confirmation": {key: value for key, value in self.expected.items() if key != field}})
        invalid.append({"expect_exit_confirmation": {**self.expected, "selector": "#bypass"}})
        for args in valid:
            with self.subTest(args=args):
                self.assertFalse(list(validator.iter_errors(args)))
                run_native_step(self.ctx, "native_restart_app", args)
        self.restart.reset_mock()
        for args in invalid:
            with self.subTest(args=args):
                self.assertTrue(list(validator.iter_errors(args)))
                with self.assertRaises(StepError):
                    run_native_step(self.ctx, "native_restart_app", args)
        self.restart.assert_not_called()
        self.assertEqual(len(self.receipts()), 2)

    def test_missing_launcher_is_an_explicit_failure(self):
        del self.session.application_restarter
        with self.assertRaisesRegex(StepError, "no owned application launcher"):
            run_native_step(self.ctx, "native_restart_app", {"expect_exit_confirmation": self.expected})
        self.assertFalse(list(self.folder.iterdir()))

    def test_selected_case_opts_in_and_existing_restart_cases_remain_null(self):
        root = Path(__file__).resolve().parents[4]
        cases = root / "qa-ui-auto-tests" / "cases"
        case = load_case(cases / "TC-EXPLORER-005-native-entries-clipboard.testcase.yaml")
        self.assertEqual([step["native_restart_app"] for step in case.steps if "native_restart_app" in step],
                         [{"expect_exit_confirmation": self.expected}])
        rows = [step["click"] for step in case.steps if "explorer-file-row" in str(step.get("click", ""))]
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(selector.endswith(" .ex-name") for selector in rows))
        for name in ("TC-WS-030-native-workspace-cold-start-restoration.testcase.yaml",
                     "TC-WS-054-release-layout-restart-and-save.testcase.yaml"):
            with self.subTest(case=name):
                doc = yaml.safe_load((cases / name).read_text(encoding="utf-8"))
                restarts = [step["native_restart_app"] for step in doc["steps"] if "native_restart_app" in step]
                self.assertTrue(restarts)
                self.assertTrue(all(args is None for args in restarts))

    def test_dialog_observation_uses_readonly_visible_dom_without_launching_a_webview(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node is required to check the read-only dialog observation")
        harness = """
const assert = require('node:assert/strict');
const script = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const observe = new Function('document', 'getComputedStyle', script);
const element = (text = '') => ({
  textContent: text,
  style: { display: 'block', visibility: 'visible', opacity: '1' },
  disabled: false,
  getBoundingClientRect: () => ({ width: 120, height: 30 }),
  getAttribute: () => null,
});
const message = element('There is 1 open tab. Exit Taomni and close it?');
const button = element('Exit');
const dialog = element();
dialog.getAttribute = key => key === 'aria-label' ? 'Exit' : null;
dialog.querySelector = selector => {
  assert.equal(selector, '[data-testid="confirm-dialog-message"]');
  return message;
};
dialog.querySelectorAll = selector => {
  assert.equal(selector, '[data-testid="confirm-dialog-confirm"]');
  return button.present === false ? [] : [button];
};
let dialogs = [];
const document = { querySelectorAll: selector => {
  assert.equal(selector, '[data-testid="confirm-dialog"]');
  return dialogs;
}};
const read = () => observe(document, el => el.style);
assert.equal(read(), null);
dialogs = [dialog];
assert.deepEqual(read(), {
  count: 1, title: 'Exit', message: message.textContent, confirm_label: 'Exit',
  confirm_count: 1, confirm_visible: true, confirm_enabled: true,
});
dialog.style.display = 'none';
assert.equal(read(), null);
dialog.style.display = 'block';
button.style.visibility = 'hidden';
assert.equal(read().confirm_visible, false);
button.style.visibility = 'visible';
button.disabled = true;
assert.equal(read().confirm_enabled, false);
button.disabled = false;
button.present = false;
assert.equal(read().confirm_count, 0);
assert.equal(read().confirm_visible, false);
button.present = true;
dialogs = [dialog, dialog];
assert.equal(read().count, 2);
"""
        result = subprocess.run([node, "-e", harness], input=json.dumps(EXIT_DIALOG_OBSERVATION),
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
