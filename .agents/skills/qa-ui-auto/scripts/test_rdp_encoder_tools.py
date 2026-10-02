"""Encoder QA tool boundaries, readiness and failure cleanup (all OS calls mocked)."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
from contextlib import nullcontext
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

from qa_ui_auto import rdp_steps as steps
from qa_ui_auto.fixtures import xrdp_server_required as xrdp
from qa_ui_auto.fixtures import rdp_baseline_required as baseline
from qa_ui_auto.rdp_helpers.rdp_target import photo_noise
from qa_ui_auto.rdp_helpers import mstsc
from qa_ui_auto.steps import StepError


class EncoderToolsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.case = self.root / "report" / "case"
        self.case.mkdir(parents=True)
        self.ctx = SimpleNamespace(case_dir=self.case, session=Mock(), restore_host_permissions=Mock())
        consent = patch.object(steps, "file_launch_consent", side_effect=nullcontext)
        consent.start()
        self.addCleanup(consent.stop)

    def test_copy_preserves_reference_oracle_and_waits_for_ready(self):
        source = self.root / "fixture"
        source.mkdir()
        state = source / "flip-state.json"
        state.write_text('{"ready":false}', encoding="utf-8")
        with patch.dict(os.environ, {"QA_RDP_REFERENCE_DIR": str(source)}), \
             patch.object(steps.time, "sleep", side_effect=lambda _: state.write_text('{"ready":true,"flips":1}', encoding="utf-8")):
            steps._do_host_copy_file(self.ctx, {"from_env_dir": "QA_RDP_REFERENCE_DIR", "name": state.name,
                                                "to": "ready.json", "expect": {"ready": True}})
        self.assertEqual(json.loads((self.case / "ready.json").read_text())["flips"], 1)

    def test_copy_rejects_path_escape_and_unapproved_environment(self):
        with patch.dict(os.environ, {"QA_RDP_REFERENCE_DIR": str(self.root)}):
            for name in ("../secret", "a/b", "a\\b", "C:secret", ".."):
                with self.assertRaises(StepError):
                    steps._do_host_copy_file(self.ctx, {"from_env_dir": "QA_RDP_REFERENCE_DIR", "name": name, "to": "x"})
            with self.assertRaises(StepError):
                steps._do_host_copy_file(self.ctx, {"from_env_dir": "USERPROFILE", "name": "secret", "to": "x"})
            with self.assertRaises(StepError):
                steps._do_host_copy_file(self.ctx, {"from_env_dir": "QA_RDP_REFERENCE_DIR", "name": "x", "to": "../../escape"})

    def test_mstsc_launch_failure_removes_stored_credentials(self):
        with patch.object(steps.platform, "system", return_value="Windows"), \
             patch.dict(os.environ, {"QA_RDP_USER": "fixture-user", "QA_RDP_PASSWORD": "dummy-password"}), \
             patch.object(steps.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run, \
             patch.object(steps, "launch_mstsc", side_effect=OSError("launch failed")):
            with self.assertRaisesRegex(OSError, "launch failed"):
                steps._do_host_mstsc(self.ctx, {"action": "start"})
        self.assertEqual(run.call_args_list[-1].args[0], ["cmdkey", "/delete:TERMSRV/127.0.0.1"])
        self.assertNotIn("dummy-password", (self.case / "mstsc.rdp").read_text(encoding="utf-16"))

    def test_mstsc_teardown_stops_only_the_owned_process(self):
        process = Mock(pid=12345)
        with patch.object(steps.platform, "system", return_value="Windows"), \
             patch.dict(os.environ, {"QA_RDP_USER": "fixture-user", "QA_RDP_PASSWORD": "dummy-password"}), \
             patch.object(steps.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
             patch.object(steps, "launch_mstsc", return_value=process), \
             patch.object(steps, "_stop_process") as stop:
            steps._do_host_mstsc(self.ctx, {"action": "start"})
            steps._do_host_mstsc(self.ctx, {"action": "stop"})
            stop.assert_called_once_with(process)
            self.assertIsNone(self.ctx._mstsc_process)

    def test_mstsc_file_uses_absolute_path_and_single_crlf_lines(self):
        process = Mock(pid=12345)
        process.poll.return_value = None
        with patch.object(steps.platform, "system", return_value="Windows"), \
             patch.dict(os.environ, {"QA_RDP_USER": "fixture-user", "QA_RDP_PASSWORD": "dummy-password"}), \
             patch.object(steps.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")), \
             patch.object(steps, "launch_mstsc", return_value=process) as launch, \
             patch.object(steps, "_stop_process"), \
             patch.object(steps, "_capture_mstsc", side_effect=RuntimeError("capture failed")) as capture:
            steps._do_host_mstsc(self.ctx, {"action": "start"})
            launch.assert_called_once_with(self.case / "mstsc.rdp", 3389)
            raw = (self.case / "mstsc.rdp").read_bytes().decode("utf-16")
            self.assertIn("\r\nusername:s:fixture-user\r\n", raw)
            self.assertNotIn("\r\r\n", raw)
            steps._do_host_mstsc(self.ctx, {"action": "stop"})
            capture.assert_called_once()
            self.assertIsNone(self.ctx._mstsc_process)

    def test_mstsc_native_launch_sets_the_desktop_and_owns_its_handles(self):
        import ctypes
        api = Mock()
        def create(application, command, proc, thread, inherit, flags, env, directory, startup, info):
            self.assertEqual(startup._obj.lpDesktop, r"winsta0\default")
            self.assertEqual(startup._obj.wShowWindow, 1)
            self.assertEqual(startup._obj.cb, ctypes.sizeof(mstsc.StartupInfo))
            self.assertFalse(inherit)
            self.assertIn(str((self.case / "mstsc.rdp").resolve()), command.value)
            self.assertIn("/v:127.0.0.1:45678", command.value)
            info._obj.hProcess, info._obj.hThread, info._obj.dwProcessId = 42, 43, 44
            return True
        api.CreateProcessW.side_effect = create
        api.GetExitCodeProcess.side_effect = lambda handle, code: setattr(code._obj, "value", 0) or True
        api.WaitForSingleObject.return_value = 0
        with patch.dict(os.environ, {"SystemRoot": r"C:\Windows"}), \
             patch.object(mstsc.ctypes, "WinDLL", return_value=api, create=True):
            process = mstsc.launch(self.case / "mstsc.rdp", 45678)
            self.assertEqual(process.pid, 44)
            self.assertEqual(process.wait(timeout=1), 0)
            process.close()
            process.close()
        self.assertEqual([call.args[0] for call in api.CloseHandle.call_args_list], [43, 42])

    def test_hosted_file_consent_restores_an_existing_setting_after_failure(self):
        registry = MagicMock()
        key = registry.CreateKeyEx.return_value.__enter__.return_value
        registry.QueryValueEx.side_effect = [(0, 4), (2, 4), ("old-loopback-setting", 1)]
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), patch.dict(sys.modules, {"winreg": registry}):
            with self.assertRaisesRegex(RuntimeError, "client failed"):
                with mstsc.file_launch_consent():
                    raise RuntimeError("client failed")
        writes = [call.args for call in registry.SetValueEx.call_args_list]
        self.assertEqual(writes, [
            (key, "RdpLaunchConsentAccepted", 0, registry.REG_DWORD, 1),
            (key, "RedirectionWarningDialogVersion", 0, registry.REG_DWORD, 1),
            (key, "127.0.0.1", 0, registry.REG_DWORD, 0x4C),
            (key, "127.0.0.1", 0, 1, "old-loopback-setting"),
            (key, "RedirectionWarningDialogVersion", 0, 4, 2),
            (key, "RdpLaunchConsentAccepted", 0, 4, 0),
        ])
        registry.DeleteValue.assert_not_called()

    def test_hosted_file_consent_removes_only_its_previously_absent_value(self):
        registry = MagicMock()
        key = registry.CreateKeyEx.return_value.__enter__.return_value
        registry.QueryValueEx.side_effect = FileNotFoundError()
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), patch.dict(sys.modules, {"winreg": registry}):
            with mstsc.file_launch_consent():
                pass
        self.assertEqual([call.args for call in registry.DeleteValue.call_args_list], [
            (key, "127.0.0.1"), (key, "RedirectionWarningDialogVersion"), (key, "RdpLaunchConsentAccepted")])
        registry.DeleteKey.assert_not_called()
        registry.reset_mock()
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), patch.dict(sys.modules, {"winreg": registry}):
            with mstsc.file_launch_consent():
                pass
        registry.CreateKeyEx.assert_not_called()

    def test_hosted_file_consent_restores_prior_changes_if_machine_policy_is_unavailable(self):
        registry = MagicMock()
        key = registry.CreateKeyEx.return_value.__enter__.return_value
        registry.QueryValueEx.side_effect = [(0, 4), PermissionError("machine policy unavailable")]
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), patch.dict(sys.modules, {"winreg": registry}):
            with self.assertRaisesRegex(PermissionError, "machine policy unavailable"):
                with mstsc.file_launch_consent():
                    self.fail("launch must not continue after incomplete fixture setup")
        self.assertEqual(registry.SetValueEx.call_args.args, (key, "RdpLaunchConsentAccepted", 0, 4, 0))
        self.assertEqual(registry.SetValueEx.call_count, 2)

    def test_mstsc_stop_failure_still_removes_credentials_and_restores_the_account(self):
        process = Mock(pid=12345)
        state = MagicMock()
        with patch.object(steps.platform, "system", return_value="Windows"), \
             patch.dict(os.environ, {"QA_RDP_USER": "fixture-user", "QA_RDP_PASSWORD": "dummy-password"}), \
             patch.object(steps.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run, \
             patch.object(steps, "launch_mstsc", return_value=process), \
             patch.object(steps, "file_launch_consent", return_value=state), \
             patch.object(steps, "_stop_process", side_effect=RuntimeError("stop failed")):
            steps._do_host_mstsc(self.ctx, {"action": "start"})
            with self.assertRaisesRegex(RuntimeError, "stop failed"):
                steps._do_host_mstsc(self.ctx, {"action": "stop"})
        self.assertEqual(run.call_args_list[-1].args[0], ["cmdkey", "/delete:TERMSRV/127.0.0.1"])
        state.__exit__.assert_called_once()
        process.close.assert_called_once()

    def test_canvas_waits_for_the_decoded_pixels_and_records_quality(self):
        self.ctx.session.execute.side_effect = [None,
            {"pixels": [[0, 0, 0, 255]], "quality_level": 0},
            {"pixels": [[255, 0, 255, 255]], "quality_level": 3}]
        with patch.object(steps.time, "sleep"):
            steps._do_rdp_canvas_assert(self.ctx, {"points": [{"x": 60, "y": 100, "rgb": [255, 0, 255]}]})
        self.assertEqual(self.ctx.session.execute.call_count, 3)
        self.assertEqual(json.loads((self.case / "client-pixels.json").read_text())["quality_level"], 3)
        self.ctx.session.screenshot.assert_called_once_with(self.case / "client-pixels.png")

    def test_canvas_capture_failure_is_not_reported_as_complete_evidence(self):
        self.ctx.session.execute.return_value = {"pixels": [[255, 0, 255, 255]], "quality_level": 0}
        self.ctx.session.screenshot.side_effect = RuntimeError("WebView capture failed")
        with self.assertRaisesRegex(RuntimeError, "WebView capture failed"):
            steps._do_rdp_canvas_assert(self.ctx, {"points": [{"x": 60, "y": 100, "rgb": [255, 0, 255]}]})

    def test_photo_target_noise_is_deterministic_and_changes_each_frame(self):
        self.assertEqual(photo_noise(20, 12, 0), photo_noise(20, 12, 0))
        self.assertNotEqual(photo_noise(20, 12, 0), photo_noise(20, 12, 1))
        self.assertEqual(len(photo_noise(20, 12, 0)), 240)
        self.assertLessEqual(max(photo_noise(20, 12, 0)), 31)


class TermServiceFixtureTest(unittest.TestCase):
    def test_startup_evidence_is_redacted_and_unavailable_evidence_does_not_block_cleanup(self):
        for unavailable in (False, True):
            with self.subTest(unavailable=unavailable), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                work, report = root / "baseline", root / "report"
                work.mkdir()
                report.mkdir()
                (work / "run-key.log").write_text("fixture-user dummy-password", encoding="utf-8")
                (work / "flip-state.json").write_text('{"ready":true}', encoding="utf-8")
                if unavailable:
                    # A non-directory already occupies the evidence destination.
                    (report / "termservice-target").write_text("unavailable", encoding="utf-8")
                baseline._CREATED.append("fixture-user")
                baseline._ANIMATION.append("unset")
                with patch.object(baseline.platform, "system", return_value="Windows"), \
                     patch.object(baseline, "WORK_DIR", work), \
                     patch.dict(os.environ, {"QA_RDP_BASELINE_PASSWORD": "dummy-password"}), \
                     patch.object(baseline, "_ps", return_value=subprocess.CompletedProcess([], 0, "[]", "")) as ps:
                    baseline.teardown(SimpleNamespace(case_dir=report))
                self.assertTrue(any("Remove-LocalUser -Name 'fixture-user'" in call.args[0] for call in ps.call_args_list))
                self.assertFalse(baseline._CREATED)
                self.assertFalse(baseline._ANIMATION)
                if unavailable:
                    self.assertTrue((report / "termservice-target-error.txt").is_file())
                else:
                    self.assertEqual((report / "termservice-target/run-key.log").read_text(), "fixture-user [redacted]")
                    self.assertTrue(json.loads((report / "termservice-target/flip-state.json").read_text())["ready"])


class XrdpFixtureTest(unittest.TestCase):
    def tearDown(self):
        xrdp._STATE.clear()

    def test_config_changes_globals_only(self):
        text = "[Globals]\nport=3389\nautorun=\n[Xorg]\nport=-1\n[other]\nport=5900\n"
        result = xrdp.configure_xrdp(text, 43210)
        self.assertIn("port=tcp://127.0.0.1:43210", result)
        self.assertIn("autorun=Xorg", result)
        self.assertTrue(result.endswith("[Xorg]\nport=-1\n[other]\nport=5900\n"))
        with self.assertRaises(ValueError):
            xrdp.configure_xrdp(text, 0)

    def test_workstation_cannot_provision_xrdp(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), patch.object(xrdp, "_sudo") as sudo:
            with self.assertRaisesRegex(RuntimeError, "hosted runner"):
                xrdp.setup(SimpleNamespace())
            sudo.assert_not_called()

    def test_partial_setup_restores_services_config_and_removes_user(self):
        calls = []
        def sudo(*args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == "chpasswd":
                raise RuntimeError("injected password failure")
            return subprocess.CompletedProcess(args, 0, "", "")
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
             patch.object(xrdp.platform, "system", return_value="Linux"), \
             patch.object(xrdp.shutil, "which", return_value="/mock/tool"), \
             patch.object(Path, "read_bytes", return_value=b"[Globals]\nport=3389\nautorun=\n"), \
             patch.object(xrdp, "_sudo", side_effect=sudo), patch.object(xrdp.secrets, "token_hex", return_value="dummy"):
            with self.assertRaisesRegex(RuntimeError, "injected password failure"):
                xrdp.setup(SimpleNamespace())
        self.assertTrue(any(args[:2] == ("userdel", "-r") for args, _ in calls))
        self.assertTrue(any(args == ("tee", "/etc/xrdp/xrdp.ini") for args, _ in calls))
        self.assertTrue(any(args == ("systemctl", "start", "xrdp") for args, _ in calls))
        self.assertFalse(xrdp._STATE)

    def test_ci_xrdp_install_never_checks_docker(self):
        from ci_services import install
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
             patch("ci_services.platform.system", return_value="Linux"), patch("ci_services.command") as run:
            install(["xrdp"])
        self.assertEqual(run.call_count, 2)
        self.assertIn("xorgxrdp", run.call_args_list[1].args[0])
        self.assertFalse(any("docker" in call.args[0] for call in run.call_args_list))

    def test_xrdp_diagnostics_keep_original_logs_and_redact_password(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory))
            xrdp._STATE["user"] = "qaxrdp-test"
            with patch.dict(os.environ, {"QA_XRDP_PASSWORD": "dummy-password"}), \
                 patch.object(xrdp, "_sudo", return_value=subprocess.CompletedProcess([], 0, "session failed dummy-password", "")):
                xrdp._collect_diagnostics(ctx)
            logs = list((ctx.case_dir / "xrdp-diagnostics").glob("*.log"))
            self.assertEqual(len(logs), 5)
            for path in logs:
                self.assertIn("session failed [redacted]", path.read_text())

    def test_xrdp_diagnostic_failure_does_not_prevent_teardown(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory))
            xrdp._STATE.update(user="qaxrdp-test", config=b"original-config")
            calls = []
            def sudo(*args, **kwargs):
                calls.append(args)
                if args[0] == "tail":
                    raise OSError("diagnostic unavailable")
                return subprocess.CompletedProcess(args, 0, "", "")
            with patch.object(xrdp, "_sudo", side_effect=sudo):
                xrdp.teardown(ctx)
            self.assertIn(("userdel", "-r", "qaxrdp-test"), calls)
            self.assertFalse(xrdp._STATE)
            self.assertTrue((ctx.case_dir / "xrdp-diagnostics/collection-error.json").is_file())


if __name__ == "__main__":
    unittest.main()
