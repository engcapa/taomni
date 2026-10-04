"""Native host-target launch and owned-process cleanup boundaries."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto import rdp_steps as steps
from qa_ui_auto.steps import StepError


class HostTargetTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.case = Path(self.directory.name) / "case"
        self.case.mkdir()
        self.ctx = SimpleNamespace(case_dir=self.case, restore_host_permissions=Mock())

    def launch(self, system, mode="flip", **extra):
        process = Mock()
        process.poll.return_value = None

        def spawn(command, **kwargs):
            state = Path(command[command.index("--state") + 1])
            state.write_text(json.dumps({"ready": True, "flips": 0,
                                         "window": {"x": 40, "y": 80}}), encoding="utf-8")
            return process

        with patch.object(steps.platform, "system", return_value=system), \
             patch.object(steps.subprocess, "Popen", side_effect=spawn) as start:
            result = steps._do_host_helper(self.ctx, {"action": "start", "name": "target",
                                                    "mode": mode, **extra})
        self.addCleanup(self.ctx.restore_host_permissions)
        self.assertTrue(start.call_args.kwargs["stdout"].closed)
        return start.call_args.args[0], process, result

    def test_macos_flip_target_uses_a_separate_native_gui_identity(self):
        command, process, result = self.launch("Darwin", pattern=True, geometry="480x320+40+80")
        self.assertEqual(command[:2], ["swift", str(steps.HELPERS / "rdp_target_macos.swift")])
        self.assertNotIn(steps.sys.executable, command)
        self.assertIn("--pattern", command)
        self.assertEqual(command[command.index("--geometry") + 1], "480x320+40+80")
        self.assertEqual(command[command.index("--state") + 1], str((self.case / "target-state.json").resolve()))
        self.assertIn("ready", result)
        with patch.object(steps, "_stop_process") as stop:
            self.ctx.restore_host_permissions()
            stop.assert_called_once_with(process)
            self.ctx.restore_host_permissions()
            stop.assert_called_once_with(process)

    def test_windows_and_linux_keep_the_same_tk_target_and_state_contract(self):
        for system in ("Windows", "Linux"):
            self.ctx = SimpleNamespace(case_dir=self.case, restore_host_permissions=Mock())
            command, _, _ = self.launch(system)
            self.assertEqual(command[:2], [steps.sys.executable, str(steps.HELPERS / "rdp_target.py")])
            self.assertEqual(command[command.index("--mode") + 1], "flip")

    def test_animation_measurements_keep_their_existing_tk_source(self):
        for mode in ("animate", "photo"):
            self.ctx = SimpleNamespace(case_dir=self.case, restore_host_permissions=Mock())
            command, _, _ = self.launch("Darwin", mode)
            self.assertEqual(command[:2], [steps.sys.executable, str(steps.HELPERS / "rdp_target.py")])
            self.assertEqual(command[command.index("--mode") + 1], mode)

    def test_helper_exit_never_creates_a_ready_result_and_remains_owned(self):
        process = Mock()
        process.poll.return_value = 1
        with patch.object(steps.platform, "system", return_value="Darwin"), \
             patch.object(steps.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(StepError, "target exited early"):
                steps._do_host_helper(self.ctx, {"action": "start", "name": "target"})
        self.assertFalse((self.case / "target-state.json").exists())
        with patch.object(steps, "_stop_process") as stop:
            self.ctx.restore_host_permissions()
            stop.assert_called_once_with(process)

    def test_spawn_failure_closes_the_log_without_claiming_a_process(self):
        with patch.object(steps.subprocess, "Popen", side_effect=OSError("launch failed")) as start:
            with self.assertRaisesRegex(OSError, "launch failed"):
                steps._do_host_helper(self.ctx, {"action": "start"})
        self.assertTrue(start.call_args.kwargs["stdout"].closed)
        self.assertEqual(self.ctx._rdp_helpers, {})


if __name__ == "__main__":
    unittest.main()
