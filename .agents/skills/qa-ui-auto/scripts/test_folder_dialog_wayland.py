"""Owned chooser selection/cancel and failures on the native Wayland transport."""
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from qa_ui_auto import folder_dialog_wayland as helper
from qa_ui_auto.steps import StepError


class WaylandFolderDialogTests(TestCase):
    def setUp(self):
        self.ctx = SimpleNamespace(session=SimpleNamespace(application="/qa/taomni"))
        self.window = {"pid": 123, "title": "Select folder to open"}

    def operate(self, path=None):
        return helper.operate(self.ctx, path, "Select folder to open")

    @patch.object(helper.time, "sleep")
    @patch.object(helper.wayland, "command")
    def test_cancel_activates_only_the_owned_dialog_and_waits_for_close(self, command, sleep):
        command.side_effect = [self.window, None, None, RuntimeError("found 0")]
        result = self.operate()
        self.assertEqual(result["pid"], 123)
        self.assertEqual(command.call_args_list[1].kwargs,
                         {"application": "/qa/taomni", "title": "Select folder to open"})
        self.assertEqual(command.call_args_list[2].kwargs, {"chords": [[0xff1b]]})

    @patch.object(helper.time, "sleep")
    @patch.object(helper.wayland, "command")
    def test_choose_enters_full_path_and_uses_open_without_enter_navigation(self, command, sleep):
        def respond(name, **args):
            if name == "geometry":
                if command.call_count == 1:
                    return self.window
                raise RuntimeError("found 0")
        command.side_effect = respond
        self.operate(Path("/qa/project with spaces"))
        inputs = [(c.args[0], c.kwargs) for c in command.call_args_list if c.args[0] in {"text", "keys"}]
        self.assertEqual(inputs, [("keys", {"chords": [[0xffe9, 0xff50]]}),
                                  ("keys", {"chords": [[0xffe3, ord("l")]]}),
                                  ("text", {"text": "/qa/project with spaces"}),
                                  ("keys", {"chords": [[0xffe9, ord("o")]]})])

    @patch.object(helper.wayland, "command", side_effect=RuntimeError("found 2"))
    def test_ambiguous_ownership_never_injects_input(self, command):
        with self.assertRaisesRegex(RuntimeError, "found 2"):
            self.operate()
        command.assert_called_once()

    @patch.object(helper.wayland, "command", side_effect=RuntimeError("socket unavailable"))
    def test_compositor_failure_is_not_mistaken_for_a_closed_dialog(self, command):
        with self.assertRaisesRegex(RuntimeError, "socket unavailable"):
            self.operate()

    @patch.object(helper.time, "sleep")
    @patch.object(helper.time, "monotonic", side_effect=[0, 0, 21])
    @patch.object(helper.wayland, "command", side_effect=RuntimeError("found 0"))
    def test_missing_dialog_fails_instead_of_reporting_cancel_success(self, command, clock, sleep):
        with self.assertRaisesRegex(StepError, "no owned Wayland chooser"):
            self.operate()
