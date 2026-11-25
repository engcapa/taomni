"""Pure unit contracts: an observed relaunch must never become a manual launch."""
from contextlib import ExitStack
import ctypes
import os
from pathlib import Path
import signal
import struct
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from native_macos_process import AdoptedProcess, BsdInfo, listener_pid, parse_environment
from native_restore_relaunch import CONFIRM, confirm_restore_relaunch
from tauri_webdriver import NativeSession
from qa_ui_auto.behavior_contract import is_check
from qa_ui_auto.restore_relaunch import run, run_mfa
from qa_ui_auto.steps import StepError


class ProcessObservationTests(unittest.TestCase):
    def test_environment_extracts_only_qa_keys_after_all_arguments(self):
        payload = (struct.pack("=i", 2) + b"/owned/taomni\0\0\0/owned/taomni\0--argument\0"
                   b"UNRELATED_TOKEN=never retained\0NEWMOB_DATA_DIR=/owned/data\0"
                   b"TAOMNI_QA_WEBDRIVER_PORT=4444\0\0")
        self.assertEqual(parse_environment(payload, {"NEWMOB_DATA_DIR", "TAOMNI_QA_WEBDRIVER_PORT"}),
                         {"NEWMOB_DATA_DIR": "/owned/data", "TAOMNI_QA_WEBDRIVER_PORT": "4444"})
        self.assertEqual(ctypes.sizeof(BsdInfo), 136)

    def test_incomplete_and_duplicate_environment_cannot_establish_isolation(self):
        for payload in (b"", struct.pack("=i", -1), struct.pack("=i", 1) + b"missing null",
                        struct.pack("=i", 2) + b"/app\0\0/app\0incomplete",
                        struct.pack("=i", 1) + b"/app\0\0/app\0QA=a\0QA=b\0"):
            with self.subTest(payload=payload), self.assertRaises(RuntimeError):
                parse_environment(payload, {"QA"})

    def test_bridge_listener_requires_one_unique_kernel_pid(self):
        for output, code, error, expected in (("", 1, "", None), ("12\n12\n", 0, "", 12)):
            with patch("native_macos_process.subprocess.run", return_value=SimpleNamespace(
                stdout=output, returncode=code, stderr=error)):
                self.assertEqual(listener_pid(4444), expected)
        for output, code, error in (("12\n13\n", 0, ""), ("", 1, "permission denied"), ("invalid", 0, "")):
            with patch("native_macos_process.subprocess.run", return_value=SimpleNamespace(
                stdout=output, returncode=code, stderr=error)), self.assertRaises(RuntimeError):
                listener_pid(4444)

    def test_cleanup_never_signals_a_reused_pid_and_does_not_invent_exit_zero(self):
        original = {"pid": 123, "start_sec": 12, "start_usec": 34, "executable": "/owned/app"}
        owner = AdoptedProcess(original)
        with patch("native_macos_process.identity", return_value=original), patch("native_macos_process.os.kill") as kill:
            owner.terminate()
            kill.assert_called_once_with(123, signal.SIGTERM)
            self.assertIsNone(owner.poll())
        for current in (None, {**original, "start_usec": 35}, {**original, "executable": "/different/app"}):
            with patch("native_macos_process.identity", return_value=current), patch("native_macos_process.os.kill") as kill:
                owner.kill()
                kill.assert_not_called()
                self.assertEqual(owner.wait(timeout=0), AdoptedProcess.EXIT_UNAVAILABLE)
                self.assertNotEqual(owner.returncode, 0)
        with patch("native_macos_process.identity", return_value=original), self.assertRaises(subprocess.TimeoutExpired):
            AdoptedProcess(original).wait(timeout=0)


class RelaunchTests(unittest.TestCase):
    def scenario(self, stack, root, *, exit_code=0, after_pid=222, wrong_environment=False, system="Darwin"):
        binary = root / "taomni"
        binary.write_bytes(b"unit-only fixture; never executed")
        isolation = {f"NEWMOB_{kind.upper()}_DIR": str(root / kind) for kind in ("data", "config", "cache")}
        expected = {**isolation, "TAOMNI_QA_WEBDRIVER_HOST": "127.0.0.1", "TAOMNI_QA_WEBDRIVER_PORT": "4444"}
        stack.enter_context(patch.dict(os.environ, isolation))
        original = Mock(pid=111)
        original.poll.side_effect = [None, None, 0]
        original.wait.return_value = exit_code
        driver = SimpleNamespace(proc=original, macos_lldb=False, report_root=root,
                                 host="127.0.0.1", port=4444, start=Mock())
        ready = {"dialog": True, "count": 1, "enabled": True, "visible": True, "staged": False, "error": None}
        session = NativeSession("http://127.0.0.1:4444", binary)
        session.transport = "macOS WKWebView bridge" if system == "Darwin" else "Taomni QA WebView bridge"
        session.session_id = "constant-mac-id"
        session.execute = Mock(side_effect=[ready, {**ready, "staged": True, "enabled": False}])
        session.click, session.close = Mock(), Mock()
        def attach():
            session.session_id = "constant-mac-id"
        session.start = Mock(side_effect=attach)
        def current(pid):
            return {"pid": pid, "start_sec": pid, "start_usec": 1, "executable": str(binary)}
        stack.enter_context(patch("native_restore_relaunch.platform.system", return_value=system))
        stack.enter_context(patch("native_restore_relaunch.identity", side_effect=current))
        stack.enter_context(patch("native_restore_relaunch.listener_pid", side_effect=[111, after_pid, after_pid]))
        stack.enter_context(patch("native_restore_relaunch.environment", side_effect=lambda pid, keys:
            {**expected, "NEWMOB_DATA_DIR": "/different"} if wrong_environment and pid != 111 else expected))
        stack.enter_context(patch("native_restore_relaunch.time.sleep"))
        return driver, session

    def test_real_click_staged_success_normal_exit_and_existing_child_attachment(self):
        for system in ("Darwin", "Linux", "Windows"):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                driver, session = self.scenario(stack, Path(directory).resolve(), system=system)
                result = confirm_restore_relaunch(driver, session)
                self.assertTrue(result["passed"])
                self.assertFalse(result["manual_launch"])
                self.assertEqual(result["original_exit_code"], 0)
                self.assertNotEqual(result["before"]["pid"], result["after"]["pid"])
                self.assertIsInstance(driver.proc, AdoptedProcess)
                session.click.assert_called_once_with(CONFIRM)
                session.start.assert_called_once_with()
                session.close.assert_not_called()
                driver.start.assert_not_called()

    def test_crash_same_pid_and_changed_isolation_all_fail_without_manual_fallback(self):
        for kwargs in ({"exit_code": 1}, {"after_pid": 111}, {"wrong_environment": True}):
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                driver, session = self.scenario(stack, Path(directory).resolve(), **kwargs)
                with self.assertRaises(RuntimeError):
                    confirm_restore_relaunch(driver, session)
                self.assertFalse(session.restore_relaunch_observation["passed"])
                driver.start.assert_not_called()
                session.start.assert_not_called()
                session.close.assert_not_called()
                session.click.assert_called_once_with(CONFIRM)

    def test_existing_child_attachment_discards_the_exited_bridge_connection_without_replaying_input(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            driver, session = self.scenario(stack, Path(directory).resolve())
            old_connection = Mock()
            session._connection = old_connection

            def attach():
                if session._connection is old_connection:
                    raise ConnectionResetError(54, "Connection reset by peer")
                old_connection.close.assert_called_once_with()
                self.assertEqual(session.restore_relaunch_observation["original_exit_code"], 0)
                self.assertIsInstance(driver.proc, AdoptedProcess)
                session.session_id = "constant-mac-id"

            session.start.side_effect = attach
            result = confirm_restore_relaunch(driver, session)
            self.assertTrue(result["passed"])
            self.assertTrue(result["previous_connection_closed"])
            session.start.assert_called_once_with()
            session.click.assert_called_once_with(CONFIRM)
            session.close.assert_not_called()
            driver.start.assert_not_called()

    def test_intercepted_confirmation_is_never_replayed(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            driver, session = self.scenario(stack, Path(directory).resolve())
            session.click.side_effect = RuntimeError("intercepted input")
            with self.assertRaisesRegex(RuntimeError, "intercepted"):
                confirm_restore_relaunch(driver, session)
            session.click.assert_called_once_with(CONFIRM)
            session.start.assert_not_called()
            driver.start.assert_not_called()

    def test_a_new_bridge_connection_failure_is_not_retried_or_counted_as_a_relaunch_pass(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            driver, session = self.scenario(stack, Path(directory).resolve())
            old_connection = Mock()
            session._connection = old_connection
            session.start.side_effect = ConnectionResetError(54, "new bridge failure")
            with self.assertRaisesRegex(ConnectionResetError, "new bridge failure"):
                confirm_restore_relaunch(driver, session)
            old_connection.close.assert_called_once_with()
            self.assertFalse(session.restore_relaunch_observation["passed"])
            self.assertEqual(session.restore_relaunch_observation["stage"], "attach-existing-process")
            session.start.assert_called_once_with()
            session.click.assert_called_once_with(CONFIRM)
            session.close.assert_not_called()
            driver.start.assert_not_called()

    def test_other_drivers_cannot_launch_a_new_app_disguised_as_attachment(self):
        for system in ("Linux", "Windows"):
            with patch("native_restore_relaunch.platform.system", return_value=system):
                session = SimpleNamespace()
                with self.assertRaises(RuntimeError):
                    confirm_restore_relaunch(SimpleNamespace(), session)
                self.assertFalse(session.restore_relaunch_observation["passed"])

    def test_verb_records_failure_and_rejects_yaml_control_of_paths_and_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            session = SimpleNamespace(restore_relauncher=Mock(side_effect=RuntimeError("failed")),
                                      restore_relaunch_observation={"passed": False})
            ctx = SimpleNamespace(session=session, case_dir=Path(directory))
            with self.assertRaises(RuntimeError):
                run(ctx, None)
            self.assertIn('"passed": false', (ctx.case_dir / "native-restore-relaunch.jsonl").read_text())
            for args in ({}, {"pid": 1}, {"command": "anything"}, {"path": "/elsewhere"}):
                with self.assertRaises(StepError):
                    run(ctx, args)
            self.assertTrue(is_check({"native_confirm_restore_relaunch": None}))

    def test_mfa_relaunch_checks_the_account_for_each_installed_package_scenario(self):
        state = {"targetPresent": False, "pointerSha256": "package", "legacyRowsSha256": "original"}
        for case_id, expected_issuer in [
            ("TC-MODULES-038", "Signed Upgrade"),
            ("TC-MODULES-044", "Installed MFA Upgrade"),
        ]:
            with self.subTest(case_id=case_id), tempfile.TemporaryDirectory() as directory:
                session = SimpleNamespace(mfa_upgrade_relauncher=Mock(), mfa_upgrade_relaunch_observation={"passed": True})
                ctx = SimpleNamespace(session=session, case_dir=Path(directory),
                                      fixture_context=SimpleNamespace(case_id=case_id))
                with patch("qa_ui_auto.restore_relaunch.installed_mfa_state",
                           side_effect=[state, {**state, "targetPresent": True}]):
                    run_mfa(ctx, None)
                session.mfa_upgrade_relauncher.assert_called_once_with(expected_issuer=expected_issuer)
                with self.assertRaises(StepError):
                    run_mfa(ctx, {"expected_issuer": "override"})


if __name__ == "__main__":
    unittest.main()
