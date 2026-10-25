import json
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from qa_ui_auto import folder_dialog
from qa_ui_auto.steps import StepError


class FolderDialogContracts(unittest.TestCase):
    def test_only_existing_directories_inside_this_run_can_be_selected(self):
        with TemporaryDirectory() as directory, TemporaryDirectory() as outside:
            run = Path(directory)
            case = run / "case"
            case.mkdir()
            root = run / "fixtures" / "project with spaces"
            root.mkdir(parents=True)
            ctx = SimpleNamespace(case_dir=case)
            self.assertEqual(folder_dialog.selected_path(ctx, {"action": "choose", "path": str(root)}), root.resolve())
            for path in [outside, str(run / "missing"), str(case / "../..")]:
                with self.subTest(path=path), self.assertRaises(StepError):
                    folder_dialog.selected_path(ctx, {"action": "choose", "path": path})
            (root / "file").write_text("fixture")
            with self.assertRaises(StepError):
                folder_dialog.selected_path(ctx, {"action": "choose", "path": str(root / "file")})

    def test_symlink_cannot_escape_the_owned_run(self):
        with TemporaryDirectory() as directory, TemporaryDirectory() as outside:
            root = Path(directory)
            (root / "case").mkdir()
            (root / "link").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(StepError):
                folder_dialog.selected_path(SimpleNamespace(case_dir=root / "case"), {"action": "choose", "path": str(root / "link")})

    def test_cancel_has_no_selected_path_and_bad_arguments_fail(self):
        ctx = SimpleNamespace()
        self.assertIsNone(folder_dialog.selected_path(ctx, {"action": "cancel"}))
        for args in [None, {}, {"action": "cancel", "path": "/"}, {"action": "choose"}, {"action": "mock", "result": "/"}]:
            with self.subTest(args=args), self.assertRaises(StepError):
                folder_dialog.selected_path(ctx, args)

    def test_os_command_failure_never_reports_success(self):
        with patch.object(folder_dialog.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "permission denied")):
            with self.assertRaisesRegex(StepError, "permission denied"):
                folder_dialog.command("xdotool", "search")

    def test_unsupported_desktop_fails_before_os_input(self):
        with patch.dict(folder_dialog.os.environ, {"DISPLAY": "", "GDK_BACKEND": "wayland"}), patch.object(folder_dialog, "command") as command:
            with self.assertRaisesRegex(StepError, "requires X11"):
                folder_dialog.linux_dialog(SimpleNamespace(), None)
            command.assert_not_called()

    def test_failed_owned_dialog_operation_is_retained_in_evidence(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory))
            with patch.object(folder_dialog.platform, "system", return_value="Linux"), patch.object(folder_dialog, "linux_dialog", side_effect=StepError("no owned dialog")):
                with self.assertRaisesRegex(StepError, "no owned dialog"):
                    folder_dialog.run_folder_dialog(ctx, {"action": "cancel"})
            result = json.loads((ctx.case_dir / "native-folder-dialogs.jsonl").read_text())
            self.assertFalse(result["passed"])
            self.assertEqual(result["action"], "cancel")
            self.assertIn("no owned dialog", result["error"])

    def test_success_records_the_actual_os_operation(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory))
            observation = {"window": "100", "pid": 123, "transport": "X11 OS keyboard"}
            with patch.object(folder_dialog.platform, "system", return_value="Linux"), patch.object(folder_dialog, "linux_dialog", return_value=observation) as operate:
                folder_dialog.run_folder_dialog(ctx, {"action": "cancel"})
            operate.assert_called_once_with(ctx, None)
            result = json.loads((ctx.case_dir / "native-folder-dialogs.jsonl").read_text())
            self.assertTrue(result["passed"])
            self.assertEqual(result["pid"], 123)

    def test_helper_timeout_preserves_its_last_os_stage(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory), session=SimpleNamespace(application="/qa/taomni"))
            error = subprocess.TimeoutExpired(["osascript"], 40, stderr=b"owned NSOpenPanel found\n")
            with patch.object(folder_dialog.platform, "system", return_value="Darwin"), patch.object(folder_dialog, "command"), patch.object(folder_dialog.subprocess, "run", side_effect=error):
                with self.assertRaises(subprocess.TimeoutExpired):
                    folder_dialog.run_folder_dialog(ctx, {"action": "cancel"})
            self.assertEqual((ctx.case_dir / "native-folder-dialog-helper.log").read_text(), "owned NSOpenPanel found\n")
            self.assertFalse(json.loads((ctx.case_dir / "native-folder-dialogs.jsonl").read_text())["passed"])

    def test_windows_helper_handles_localized_button_names_and_delayed_open(self):
        helper = (Path(__file__).parent / "qa_ui_auto" / "folder_dialog_windows.ps1").read_text(encoding="utf-8")
        self.assertIn("ControlTypeProperty", helper)
        self.assertIn('"Cancel", "取消"', helper)
        self.assertIn('"Open", "Select Folder", "Add", "Choose", "打开", "选择文件夹"', helper)
        self.assertIn("waitEnabled", helper)


if __name__ == "__main__":
    unittest.main()
