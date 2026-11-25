import json
import subprocess
import unittest
import threading
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from qa_ui_auto import file_dialog, folder_dialog
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
            link = root / "link"
            try:
                link.symlink_to(outside, target_is_directory=True)
            except OSError as error:
                if getattr(error, "winerror", None) != 1314:
                    raise
                # Junctions exercise the same resolved-path escape on Windows
                # without granting this test account symlink privileges.
                import _winapi
                _winapi.CreateJunction(outside, str(link))
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
        with patch.dict(folder_dialog.os.environ, {"DISPLAY": "", "GDK_BACKEND": "x11"}), patch.object(folder_dialog, "command") as command:
            with self.assertRaisesRegex(StepError, "requires X11"):
                folder_dialog.linux_dialog(SimpleNamespace(), None)
            command.assert_not_called()

    def test_wayland_uses_the_owned_compositor_without_x11_input(self):
        with patch.dict(folder_dialog.os.environ, {"DISPLAY": "", "GDK_BACKEND": "wayland"}), \
                patch("qa_ui_auto.folder_dialog_wayland.operate", return_value={"pid": 123}) as operate, \
                patch.object(folder_dialog, "command") as command:
            ctx = SimpleNamespace()
            self.assertEqual(folder_dialog.linux_dialog(ctx, None), {"pid": 123})
            operate.assert_called_once_with(ctx, None, folder_dialog.TITLE)
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

    def test_file_picker_timeout_retains_the_log_for_the_failed_native_step(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(
                case_dir=Path(directory),
                session=SimpleNamespace(application="/qa/taomni"),
                fixture_context=SimpleNamespace(step_index=17),
            )
            error = subprocess.TimeoutExpired(["osascript"], 60, stderr=b"Go to Folder submitted\n")
            with (
                patch.object(file_dialog.platform, "system", return_value="Darwin"),
                patch.object(folder_dialog.subprocess, "run", side_effect=error) as run,
                self.assertRaises(subprocess.TimeoutExpired),
            ):
                file_dialog.run(ctx, {"kind": "folder", "action": "choose", "path": directory})
            receipt = json.loads((ctx.case_dir / "native-file-dialogs.jsonl").read_text())
            self.assertFalse(receipt["passed"])
            self.assertEqual(receipt["step_index"], 17)
            self.assertEqual(receipt["helper_log"], "native-file-dialog-17.log")
            self.assertEqual((ctx.case_dir / receipt["helper_log"]).read_text(), "Go to Folder submitted\n")
            self.assertEqual(run.call_args.kwargs["env"]["QA_PICKER_SCREENSHOT"], str(ctx.case_dir / "native-file-dialog-17.png"))

    def test_windows_uses_the_available_powershell_7_runtime(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory), session=SimpleNamespace(application="/qa/taomni"))
            result = subprocess.CompletedProcess([], 0, '{"pid":123,"transport":"Windows Common Item Dialog controls"}', "")
            with patch.object(folder_dialog.platform, "system", return_value="Windows"), \
                    patch.object(folder_dialog.shutil, "which", return_value="C:/pwsh/pwsh.exe"), \
                    patch.object(folder_dialog.subprocess, "run", return_value=result) as run:
                folder_dialog.run_folder_dialog(ctx, {"action": "cancel"})
            self.assertEqual(run.call_args.args[0][0], "C:/pwsh/pwsh.exe")
            self.assertEqual(run.call_args.kwargs["env"]["QA_PICKER_ACTION"], "cancel")

    def test_trigger_can_wait_for_the_real_os_dialog_to_close_without_deadlocking_the_driver(self):
        with TemporaryDirectory() as directory:
            clicked, operated = threading.Event(), threading.Event()
            def click(selector):
                self.assertEqual(selector, "#add-folder")
                clicked.set()
                self.assertTrue(operated.wait(2), "driver waited before the OS helper could operate")
            def operate(ctx, path):
                self.assertTrue(clicked.wait(2))
                operated.set()
                return {"pid": 123, "transport": "actual OS helper"}
            ctx = SimpleNamespace(case_dir=Path(directory), session=SimpleNamespace(click=click))
            with patch.object(folder_dialog.platform, "system", return_value="Linux"), patch.object(folder_dialog, "linux_dialog", side_effect=operate):
                folder_dialog.run_folder_dialog(ctx, {"action": "cancel", "trigger": "#add-folder"})
            observation = json.loads((ctx.case_dir / "native-folder-dialogs.jsonl").read_text())
            self.assertTrue(observation["passed"])
            self.assertEqual(observation["trigger"], "#add-folder")
            self.assertEqual(observation["pid"], 123)

    def test_trigger_failures_are_not_hidden_by_an_os_helper_result(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory), session=SimpleNamespace(click=Mock(side_effect=StepError("click failed"))))
            with patch.object(folder_dialog.platform, "system", return_value="Linux"), patch.object(folder_dialog, "linux_dialog", return_value={"pid": 123}):
                with self.assertRaisesRegex(StepError, "click failed"):
                    folder_dialog.run_folder_dialog(ctx, {"action": "cancel", "trigger": "#add-folder"})
            self.assertFalse(json.loads((ctx.case_dir / "native-folder-dialogs.jsonl").read_text())["passed"])

    def test_invalid_trigger_is_rejected_before_input(self):
        ctx = SimpleNamespace(session=SimpleNamespace(click=Mock()))
        for trigger in ("", None, 12):
            with self.subTest(trigger=trigger), self.assertRaises(StepError):
                folder_dialog.selected_path(ctx, {"action": "cancel", "trigger": trigger})
        ctx.session.click.assert_not_called()

    def test_linux_save_dialog_clears_extension_and_retries_submit_or_cancel(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "case").mkdir()
            ctx = SimpleNamespace(case_dir=root / "case", session=SimpleNamespace(application="/bin/sh"))
            search_calls = 0

            def fake_command(*args, check=True):
                nonlocal search_calls
                if args[:2] == ("xdotool", "search"):
                    search_calls += 1
                    # Discovery -> still open after 1st submit -> closed after retry
                    return "100" if search_calls <= 3 else ""
                if args[:2] == ("xdotool", "getwindowpid"):
                    import os
                    return str(os.getpid())
                return ""

            with patch.dict(folder_dialog.os.environ, {"DISPLAY": ":99", "GDK_BACKEND": "x11"}), \
                    patch("qa_ui_auto.wayland.active", return_value=False), \
                    patch.object(Path, "resolve", return_value=Path("/bin/sh")), \
                    patch("PIL.ImageGrab.grab") as grab, \
                    patch.object(folder_dialog.time, "sleep"), \
                    patch.object(folder_dialog, "command", side_effect=fake_command) as cmd:
                folder_dialog.linux_dialog(ctx, root / "exports" / "native.png", title="Save as", kind="save")
            grab.assert_called_once()
            key_calls = [c.args for c in cmd.call_args_list if c.args[:2] == ("xdotool", "key")]
            self.assertEqual(
                key_calls,
                [
                    ("xdotool", "key", "--clearmodifiers", "ctrl+l", "ctrl+a", "BackSpace"),
                    ("xdotool", "key", "--clearmodifiers", "alt+s"),
                    ("xdotool", "key", "--clearmodifiers", "alt+s"),
                ],
            )
            search_calls = 0
            with patch.dict(folder_dialog.os.environ, {"DISPLAY": ":99", "GDK_BACKEND": "x11"}), \
                    patch("qa_ui_auto.wayland.active", return_value=False), \
                    patch.object(Path, "resolve", return_value=Path("/bin/sh")), \
                    patch("PIL.ImageGrab.grab"), \
                    patch.object(folder_dialog.time, "sleep"), \
                    patch.object(folder_dialog, "command", side_effect=fake_command) as cmd:
                folder_dialog.linux_dialog(ctx, root / "exports" / "cancelled.html", title="Save as", kind="save", cancel_after_path=True)
            key_calls = [c.args for c in cmd.call_args_list if c.args[:2] == ("xdotool", "key")]
            self.assertEqual(
                key_calls,
                [
                    ("xdotool", "key", "--clearmodifiers", "ctrl+l", "ctrl+a", "BackSpace"),
                    ("xdotool", "key", "--clearmodifiers", "alt+c"),
                    ("xdotool", "key", "--clearmodifiers", "alt+c"),
                ],
            )

    def test_control_coverage_counts_the_trigger_and_never_the_selected_disk_path(self):
        from qa_ui_auto.control_coverage import INTERACTIVE_VERBS, _selectors_in_step
        self.assertIn("native_folder_dialog", INTERACTIVE_VERBS)
        self.assertEqual(_selectors_in_step("native_folder_dialog", {
            "action": "choose", "path": "/owned/project", "trigger": "#add-folder",
        }), ["#add-folder"])
        self.assertEqual(_selectors_in_step("native_folder_dialog", {"action": "cancel"}), [])

if __name__ == "__main__":
    unittest.main()
