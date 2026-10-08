"""Encoder QA boundaries and cleanup; accounts/services are always mocked."""
import io
import json
import os
from pathlib import Path
import shutil
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
from qa_ui_auto.rdp_helpers.rdp_target import animation_delay_ms, photo_noise
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
        reporting = patch.object(mstsc, "crash_reporting", side_effect=nullcontext)
        self.reporting_context = reporting
        reporting.start()
        self.addCleanup(reporting.stop)
        capture = patch.object(mstsc, "crash_capture", side_effect=lambda *_: nullcontext())
        self.capture_context = capture
        capture.start()
        self.addCleanup(capture.stop)
        heap = patch.object(mstsc, "heap_verification", side_effect=nullcontext)
        self.heap_context = heap
        heap.start()
        self.addCleanup(heap.stop)

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

    def test_hosted_crash_reporting_restores_each_original_value_and_type_after_failure(self):
        self.reporting_context.stop()
        registry = MagicMock()
        key = registry.CreateKeyEx.return_value.__enter__.return_value
        registry.QueryValueEx.side_effect = [("prior dump folder", 1), (2, 4), FileNotFoundError()]
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), patch.dict(sys.modules, {"winreg": registry}):
            with self.assertRaisesRegex(RuntimeError, "launch failed"):
                with mstsc.crash_reporting(self.case):
                    raise RuntimeError("launch failed")
        writes = [call.args for call in registry.SetValueEx.call_args_list]
        self.assertEqual(writes[0], (key, "DumpFolder", 0, registry.REG_EXPAND_SZ, str(self.case / "mstsc-crash")))
        self.assertEqual(writes[-2:], [(key, "DumpType", 0, 4, 2), (key, "DumpFolder", 0, 1, "prior dump folder")])
        registry.DeleteValue.assert_called_once_with(key, "DumpCount")
        registry.reset_mock()
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}):
            with mstsc.crash_reporting(self.case):
                pass
        registry.CreateKeyEx.assert_not_called()

    def test_crash_stack_reads_only_the_owned_process_dump(self):
        dumps = self.case / "mstsc-crash"
        dumps.mkdir()
        (dumps / "mstsc.exe.54321.dmp").write_bytes(b"other process")
        response = SimpleNamespace(stdout="[]", stderr="")
        with patch.object(mstsc.shutil, "which", return_value="mock-cdb"), \
             patch.object(mstsc.subprocess, "run", return_value=response) as run:
            mstsc.crash_diagnostics(Mock(pid=12345), self.case)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.kwargs["env"]["QA_MSTSC_PID"], "12345")
            (dumps / "mstsc.exe.12345.dmp").write_bytes(b"owned process")
            mstsc.crash_diagnostics(Mock(pid=12345), self.case)
            self.assertEqual(run.call_args.args[0][2], str(dumps / "mstsc.exe.12345.dmp"))
        self.assertTrue((self.case / "mstsc-application-error.json").is_file())
        self.assertTrue((self.case / "mstsc-crash-stack.txt").is_file())

    def test_crash_capture_attaches_to_owned_pid_and_waits_for_the_dump(self):
        self.capture_context.stop()
        executable = self.root / "procdump64.exe"
        executable.write_bytes(b"mock executable")
        monitor = Mock()
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "QA_MSTSC_PROCDUMP": str(executable)}), \
             patch.object(mstsc.subprocess, "Popen", return_value=monitor) as start:
            with mstsc.crash_capture(Mock(pid=12345), self.case):
                monitor.wait.assert_not_called()
        self.assertEqual(start.call_args.args[0][-2:], ["12345", str(self.case / "mstsc-crash" / "owned-12345")])
        self.assertIn("-e", start.call_args.args[0])
        self.assertIn("-t", start.call_args.args[0])
        monitor.wait.assert_called_once_with(timeout=15)
        monitor.terminate.assert_not_called()

    def test_crash_capture_timeout_reaps_only_its_owned_debugger(self):
        self.capture_context.stop()
        executable = self.root / "procdump64.exe"
        executable.write_bytes(b"mock executable")
        monitor = Mock()
        monitor.wait.side_effect = [subprocess.TimeoutExpired("procdump", 15), None]
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "QA_MSTSC_PROCDUMP": str(executable)}), \
             patch.object(mstsc.subprocess, "Popen", return_value=monitor):
            with mstsc.crash_capture(Mock(pid=12345), self.case):
                pass
        monitor.terminate.assert_called_once_with()
        monitor.kill.assert_not_called()

    def test_heap_verification_restores_value_types_after_a_client_failure(self):
        self.heap_context.stop()
        executable = self.root / "gflags.exe"
        executable.write_bytes(b"mock executable")
        registry = MagicMock()
        key = registry.CreateKeyEx.return_value.__enter__.return_value
        registry.QueryValueEx.side_effect = [("prior flags", 1), (2, 4), (17, 4), FileNotFoundError(), FileNotFoundError()]
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "QA_MSTSC_GFLAGS": str(executable)}), \
             patch.dict(sys.modules, {"winreg": registry}), patch.object(mstsc.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "client failure"):
                with mstsc.heap_verification():
                    raise RuntimeError("client failure")
        self.assertEqual(run.call_args.args[0], [str(executable), "/p", "/enable", "mstsc.exe", "/full"])
        self.assertEqual([call.args for call in registry.SetValueEx.call_args_list], [
            (key, "GlobalFlag", 0, 1, "prior flags"), (key, "PageHeapFlags", 0, 4, 2), (key, "VerifierFlags", 0, 4, 17)])
        self.assertEqual([call.args for call in registry.DeleteValue.call_args_list], [
            (key, "VerifierDlls"), (key, "StackTraceDatabaseSizeInMB")])

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

    def test_canvas_resize_waits_for_new_viewport_dimensions_and_repaint(self):
        (self.case / "before.json").write_text('{"width":994,"height":750}', encoding="utf-8")
        viewport = {"width": 1492, "height": 1030}
        self.ctx.session.execute.side_effect = [
            {"width": 994, "height": 750, "viewport_size": {"width": 994, "height": 750}, "pixels": [[255, 255, 255, 255]]},
            {"width": 994, "height": 750, "viewport_size": viewport, "pixels": [[255, 255, 255, 255]]},
            {"width": 1492, "height": 1030, "viewport_size": viewport, "pixels": [[0, 0, 0, 0]]},
            {"width": 1492, "height": 1030, "viewport_size": viewport, "pixels": [[255, 255, 255, 255]]},
        ]
        with patch.object(steps.time, "sleep"):
            steps._do_rdp_canvas_assert(self.ctx, {
                "points": [{"x": 280, "y": 240, "rgb": [255, 255, 255]}],
                "match_viewport": True, "resized_from": "before.json",
            })
        self.assertEqual(self.ctx.session.execute.call_count, 4)
        self.assertEqual(json.loads((self.case / "client-pixels.json").read_text())["width"], 1492)
        self.ctx.session.screenshot.assert_called_once_with(self.case / "client-pixels.png")

    def test_canvas_matching_pixels_without_viewport_geometry_do_not_pass_resize(self):
        self.ctx.session.execute.return_value = {"width": 1492, "height": 1030, "pixels": [[255, 255, 255, 255]]}
        with patch.object(steps.time, "time", side_effect=[0, 11]):
            with self.assertRaisesRegex(StepError, "decoded client pixels"):
                steps._do_rdp_canvas_assert(self.ctx, {
                    "points": [{"x": 280, "y": 240, "rgb": [255, 255, 255]}],
                    "match_viewport": True, "timeout_sec": 10,
                })
        self.ctx.session.screenshot.assert_not_called()

    def test_photo_target_noise_is_deterministic_and_changes_each_frame(self):
        self.assertEqual(photo_noise(20, 12, 0), photo_noise(20, 12, 0))
        self.assertNotEqual(photo_noise(20, 12, 0), photo_noise(20, 12, 1))
        self.assertEqual(len(photo_noise(20, 12, 0)), 240)
        self.assertLessEqual(max(photo_noise(20, 12, 0)), 31)

    def test_animation_clock_includes_draw_cost_and_skips_elapsed_deadlines(self):
        # Drawing for 8 ms leaves only 9 ms until the first 60 Hz deadline;
        # adding a full 16 ms here would reduce the real source frame rate.
        self.assertEqual(animation_delay_ms(100.0, 100.008), 9)
        # A long draw cannot enqueue all the missed ticks or busy-spin: the
        # next draw waits for the upcoming deadline, and counts only itself.
        self.assertEqual(animation_delay_ms(100.0, 100.052), 15)
        self.assertEqual(animation_delay_ms(100.0, 100.1), 17)


class TermServiceFixtureTest(unittest.TestCase):
    def test_only_owned_reference_probes_release_the_warmed_connection(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(steps.platform, 'system', return_value='Windows'), \
             patch.dict(os.environ, {'QA_RDP_BASELINE_PORT': '3389'}), \
             patch.object(baseline, '_CREATED', ['qa-rdp-base2']), \
             patch.object(steps.subprocess, 'Popen'), \
             patch.object(steps, '_finish_probe', return_value='measured') as finish, \
             patch.object(baseline, 'disconnect_owned_session', return_value=[7]) as disconnect:
            artifact = Path(directory) / 'throughput.json'
            ctx = SimpleNamespace(case_dir=Path(directory))
            with patch.object(steps, '_probe_command', return_value=(['probe'], artifact)):
                for user, port, expected_calls in [('runneradmin', 3389, 0), ('qa-rdp-base2', 3390, 0), ('qa-rdp-base2', 3389, 1)]:
                    result = steps._do_rdp_probe(ctx, {'scenario': 'throughput', 'args': {'user': user, 'port': port}})
                    self.assertEqual(result, 'measured')
                    self.assertEqual(disconnect.call_count, expected_calls)
                disconnect.assert_called_once_with('qa-rdp-base2')
                self.assertEqual(json.loads(artifact.with_name('throughput-disconnect.json').read_text())['sessions'], [7])
                artifact.with_name('throughput-disconnect.json').unlink()
                finish.side_effect = StepError('measurement failed')
                with self.assertRaisesRegex(StepError, 'measurement failed'):
                    steps._do_rdp_probe(ctx, {'scenario': 'throughput', 'args': {'user': 'qa-rdp-base2', 'port': 3389}})
                self.assertFalse(artifact.with_name('throughput-disconnect.json').exists())

    def test_partial_host_setup_registers_accounts_before_reporting_failure(self):
        from qa_ui_auto.fixtures import FixtureSkip
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(baseline.platform, "system", return_value="Windows"), \
             patch.object(baseline, "WORK_DIR", Path(directory)), \
             patch.object(baseline, "_CREATED", []) as created, \
             patch.object(baseline, "_ANIMATION", []) as animation, \
             patch.object(baseline.shutil, "copy2"), \
             patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), \
             patch.object(baseline.subprocess, "run", side_effect=[
                 subprocess.CompletedProcess([], 0, "", ""),
                 subprocess.CompletedProcess([], 1, "created:qa-rdp-base1\nanimation:unset\n", "host setup failed")]):
            with self.assertRaisesRegex(FixtureSkip, "host setup failed"):
                baseline._setup(SimpleNamespace())
            self.assertEqual(created, ["qa-rdp-base1"])
            self.assertEqual(animation, ["unset"])

    def test_setup_retains_original_error_when_cleanup_also_fails(self):
        context = MagicMock()
        with patch.object(baseline.platform, "system", return_value="Windows"), \
             patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
             patch.dict(sys.modules, {"winreg": MagicMock()}), \
             patch.object(mstsc, "_registry_value", return_value=context), \
             patch.object(baseline, "_setup", side_effect=RuntimeError("setup failed")), \
             patch.object(baseline, "_teardown", side_effect=RuntimeError("cleanup failed")), \
             patch.object(sys, "stderr", new_callable=io.StringIO) as evidence:
            with self.assertRaisesRegex(RuntimeError, "^setup failed$"):
                baseline.setup(SimpleNamespace())
            self.assertIn("TermService setup cleanup failed: cleanup failed", evidence.getvalue())
            self.assertEqual(context.__exit__.call_count, 2)
            self.assertIsNone(baseline._SESSION_POLICY)

    def test_session_ids_match_only_the_owned_user_with_active_or_disconnected_rows(self):
        rows = (" USERNAME SESSIONNAME ID STATE IDLE TIME LOGON TIME\n"
                ">runneradmin console 1 Active none 10/2/2026 9:00 AM\n"
                " qa-rdp-base1 rdp-tcp#4 3 Active none 10/2/2026 9:00 AM\n"
                " QA-RDP-BASE1 7 Disc 2 10/2/2026 9:00 AM\n"
                " qa-rdp-base2 8 Disc 1 10/2/2026 9:00 AM\n")
        self.assertEqual(baseline.session_ids(rows, "qa-rdp-base1"), [3, 7])

    def test_disconnect_waits_for_owned_warm_session_without_touching_runner(self):
        import ctypes
        api = MagicMock()
        api.wtsapi32.WTSDisconnectSession.return_value = True
        rows = ">runneradmin console 1 Active none\n qa-rdp-base2 rdp-tcp#2 7 Active none\n"
        with patch.object(baseline.platform, 'system', return_value='Windows'), \
             patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}), \
             patch.object(baseline, '_CREATED', ['qa-rdp-base2']), \
             patch.object(baseline.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, rows)), \
             patch.object(baseline, '_session_connection_state', side_effect=[0, 0, 4]), \
             patch.object(ctypes, 'windll', api, create=True), patch('time.sleep'):
            self.assertEqual(baseline.disconnect_owned_session('qa-rdp-base2'), [7])
        api.wtsapi32.WTSDisconnectSession.assert_called_once_with(None, 7, False)

    def test_disconnect_refuses_unowned_account_and_accepts_already_disconnected(self):
        import ctypes
        api = MagicMock()
        with patch.object(baseline.platform, 'system', return_value='Windows'), \
             patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}), \
             patch.object(baseline, '_CREATED', ['qa-rdp-base2']), \
             patch.object(baseline.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'qa-rdp-base2 7 Disc none')), \
             patch.object(baseline, '_session_connection_state', return_value=4), \
             patch.object(ctypes, 'windll', api, create=True):
            with self.assertRaisesRegex(RuntimeError, 'owned hosted'):
                baseline.disconnect_owned_session('runneradmin')
            self.assertEqual(baseline.disconnect_owned_session('qa-rdp-base2'), [7])
        api.wtsapi32.WTSDisconnectSession.assert_not_called()

    def test_logoff_rejects_workstations_inherited_accounts_and_unowned_users(self):
        for hosted, owned, user in [("false", True, "qa-rdp-base1"),
                                    ("true", False, "qa-rdp-base1"),
                                    ("true", True, "runneradmin")]:
            with self.subTest(hosted=hosted, owned=owned, user=user), \
                 patch.object(baseline.platform, "system", return_value="Windows"), \
                 patch.dict(os.environ, {"GITHUB_ACTIONS": hosted}), \
                 patch.object(baseline, "_CREATED", ["qa-rdp-base1"] if owned else []), \
                 patch.object(baseline.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "owned hosted reference account"):
                    baseline.logoff_owned_session(user)
                run.assert_not_called()

    def test_logoff_waits_for_only_the_owned_session_slot_to_be_released(self):
        rows = ">runneradmin console 1 Active none\nqa-rdp-base1 3 Disc none\n"
        with patch.object(baseline.platform, "system", return_value="Windows"), \
             patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
             patch.object(baseline, "_CREATED", ["qa-rdp-base1"]), \
             patch.object(baseline.subprocess, "run", side_effect=[
                 SimpleNamespace(stdout=rows), SimpleNamespace(stdout=""),
                 SimpleNamespace(stdout=rows), SimpleNamespace(stdout=">runneradmin console 1 Active none\n")]) as run, \
             patch("time.sleep") as sleep:
            self.assertEqual(baseline.logoff_owned_session("qa-rdp-base1"), [3])
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            ["quser"], ["logoff", "3"], ["quser"], ["quser"]])
        sleep.assert_called_once_with(0.25)

    def test_session_reuse_policy_is_restored_after_partial_setup_and_cleanup_failure(self):
        context = MagicMock()
        registry = MagicMock()
        with patch.object(baseline.platform, "system", return_value="Windows"), \
             patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
             patch.dict(sys.modules, {"winreg": registry}), \
             patch.object(mstsc, "_registry_value", return_value=context), \
             patch.object(baseline, "_setup", side_effect=RuntimeError("setup failed")), \
             patch.object(baseline, "_teardown") as cleanup:
            with self.assertRaisesRegex(RuntimeError, "setup failed"):
                baseline.setup(SimpleNamespace())
            cleanup.assert_called_once()
            self.assertEqual(context.__exit__.call_count, 2)
            self.assertIsNone(baseline._SESSION_POLICY)
        context = MagicMock()
        with patch.object(baseline, "_SESSION_POLICY", context), \
             patch.object(baseline, "_teardown", side_effect=RuntimeError("cleanup failed")):
            with self.assertRaisesRegex(RuntimeError, "cleanup failed"):
                baseline.teardown(SimpleNamespace())
            context.close.assert_called_once()
            self.assertIsNone(baseline._SESSION_POLICY)

    def test_logoff_verb_does_not_write_success_evidence_after_a_failed_release(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(baseline, "logoff_owned_session", side_effect=RuntimeError("logoff failed")):
            ctx = SimpleNamespace(case_dir=Path(directory))
            with self.assertRaisesRegex(StepError, "logoff failed"):
                steps._do_host_rdp_logoff(ctx, {"user_env": "QA_RDP_BASELINE_USER1"})
            self.assertFalse((ctx.case_dir / "reference-logoff.json").exists())

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
        skeletons = []
        def sudo(*args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == "useradd":
                skeleton = Path(args[args.index("--skel") + 1])
                self.assertTrue(skeleton.is_dir())
                self.assertEqual(list(skeleton.iterdir()), [])
                skeletons.append(skeleton)
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
        self.assertEqual(len(skeletons), 1)
        self.assertFalse(skeletons[0].exists())
        self.assertFalse(xrdp._STATE)

    def test_timed_out_account_creation_still_removes_partial_account(self):
        calls = []
        def sudo(*args, **kwargs):
            calls.append(args)
            if args[0] == "useradd":
                raise RuntimeError("account creation timed out after writing passwd")
            return subprocess.CompletedProcess(args, 0, "", "")
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
             patch.object(xrdp.platform, "system", return_value="Linux"), \
             patch.object(xrdp.shutil, "which", return_value="/mock/tool"), \
             patch.object(Path, "read_bytes", return_value=b"[Globals]\nport=3389\n"), \
             patch.object(Path, "read_text", return_value="root:x:0:0:root:/root:/bin/bash\n"), \
             patch.object(xrdp, "_sudo", side_effect=sudo), \
             patch.object(xrdp.secrets, "token_hex", return_value="dummy"):
            with self.assertRaisesRegex(RuntimeError, "account creation timed out"):
                xrdp.setup(SimpleNamespace())
        self.assertIn(("userdel", "-r", "qaxrdpdummy"), calls)
        self.assertFalse(xrdp._STATE)

    @unittest.skipUnless(os.name == "posix" and shutil.which("timeout"), "GNU timeout requires POSIX")
    def test_command_timeout_kills_descendants_that_ignore_term(self):
        # Exercise a real owned process tree, without sudo/account mutations.
        real_run = subprocess.run
        def run_without_sudo(command, **kwargs):
            self.assertEqual(command[2], "timeout")
            kwargs["timeout"] = 5
            return real_run([command[2], "--signal=TERM", "--kill-after=0.1", "0.3", *command[6:]], **kwargs)
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "owned-pids.json"
            script = ("import json, os, signal, sys, time\n"
                      "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                      "child = os.fork()\n"
                      "if not child:\n"
                      "    with open(sys.argv[1], 'w') as f: json.dump([os.getppid(), os.getpid()], f)\n"
                      "while True: time.sleep(0.05)\n")
            with patch.object(xrdp.subprocess, "run", side_effect=run_without_sudo):
                with self.assertRaisesRegex(RuntimeError, "failed"):
                    xrdp._sudo(sys.executable, "-c", script, str(pid_file))
            self.assertTrue(pid_file.exists(), "the child must start before the timeout")
            for pid in json.loads(pid_file.read_text()):
                status = Path(f"/proc/{pid}/status")
                if status.exists():
                    try:
                        state = status.read_text()
                    except (FileNotFoundError, ProcessLookupError):
                        # Reaping between exists() and read_text() is the
                        # strongest possible cleanup result; procfs is a
                        # moving target while the owned process exits.
                        continue
                    self.assertRegex(state, r"State:\s+Z", "an owned descendant is still alive")

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
