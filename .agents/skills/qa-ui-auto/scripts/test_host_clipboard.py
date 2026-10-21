import json
import os
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from qa_ui_auto import host_clipboard
from qa_ui_auto.rdp_steps import _do_host_clipboard
from qa_ui_auto.steps import StepError


class HostClipboardObservationTests(unittest.TestCase):
    def assert_snapshot(self, kind, args, snapshots, expected, reads):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory))
            with patch.object(host_clipboard, f"get_{kind}", side_effect=snapshots) as read, \
                    patch("qa_ui_auto.rdp_steps.time.sleep"):
                _do_host_clipboard(ctx, {"action": "assert", "kind": kind, **args})
            records = json.loads((ctx.case_dir / "host-clipboard-observations.json").read_text())
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["value"], expected)
        self.assertEqual(read.call_count, reads)

    def test_text_contains_records_the_snapshot_that_satisfied_the_assertion(self):
        self.assert_snapshot("text", {"contains": "中文🙂"},
                             ["head\n中文🙂\ntail", "other writer"], "head\n中文🙂\ntail", 1)

    def test_text_equals_records_exactly_the_observed_text(self):
        self.assert_snapshot("text", {"equals": "\nexact\n"},
                             ["\nexact\n", "other writer"], "\nexact\n", 1)

    def test_empty_text_equality_remains_an_exact_assertion(self):
        self.assert_snapshot("text", {"equals": ""}, ["old", ""], "", 2)

    def test_nonmatching_text_is_read_again_instead_of_reusing_a_cached_value(self):
        self.assert_snapshot("text", {"contains": "new"}, ["old", "new"], "new", 2)

    def test_html_records_the_matching_snapshot_without_a_second_native_read(self):
        self.assert_snapshot("html", {"contains": "<b>中文🙂</b>"},
                             ["<b>中文🙂</b>", "other writer"], "<b>中文🙂</b>", 1)

    def test_html_retries_until_a_matching_snapshot(self):
        self.assert_snapshot("html", {"contains": "<b>new</b>"},
                             ["<p>old</p>", "<b>new</b>"], "<b>new</b>", 2)

    def test_persistent_mismatch_fails_without_publishing_a_success_observation(self):
        for kind in ("text", "html"):
            with self.subTest(kind=kind), TemporaryDirectory() as directory:
                ctx = SimpleNamespace(case_dir=Path(directory))
                with patch.object(host_clipboard, f"get_{kind}", return_value="old"), \
                        patch("qa_ui_auto.rdp_steps.time.time", side_effect=[0, 1]), \
                        self.assertRaisesRegex(StepError, "not satisfied"):
                    _do_host_clipboard(ctx, {"action": "assert", "kind": kind,
                                             "contains": "new", "timeout_sec": 1})
                self.assertFalse((ctx.case_dir / "host-clipboard-observations.json").exists())

    def test_unavailable_os_oracle_still_fails(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory))
            with patch.object(host_clipboard, "get_text", side_effect=RuntimeError("OS tool unavailable")), \
                    patch("qa_ui_auto.rdp_steps.time.time", side_effect=[0, 1]), \
                    self.assertRaisesRegex(StepError, "OS tool unavailable"):
                _do_host_clipboard(ctx, {"action": "assert", "kind": "text",
                                         "contains": "new", "timeout_sec": 1})


class WaylandTextClipboardTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-qa", "GDK_BACKEND": "wayland", "DISPLAY": ":99"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.system = patch.object(host_clipboard, "SYSTEM", "Linux")
        self.system.start()
        self.addCleanup(self.system.stop)

    def test_wayland_read_preserves_unicode_and_newlines_without_x11_fallback(self):
        with patch.object(host_clipboard.shutil, "which", return_value="/usr/bin/wl-paste"), \
                patch.object(host_clipboard, "_run", return_value="你好\n".encode()) as run, \
                patch.object(host_clipboard, "_xclip_get") as xclip:
            self.assertEqual(host_clipboard.get_text(), "你好\n")
        run.assert_called_once_with(["wl-paste", "--no-newline", "--type", "text"], timeout=10)
        xclip.assert_not_called()

    def test_wayland_write_owns_real_clipboard_without_capture_pipes(self):
        with patch.object(host_clipboard.shutil, "which", return_value="/usr/bin/wl-copy"), \
                patch.object(host_clipboard.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                patch.object(host_clipboard, "_xclip_set") as xclip:
            host_clipboard.set_text("你好\n")
        self.assertEqual(run.call_args.args[0], ["wl-copy", "--type", "text/plain;charset=utf-8"])
        self.assertEqual(run.call_args.kwargs['input'], "你好\n".encode())
        self.assertEqual(run.call_args.kwargs['stdout'], subprocess.DEVNULL)
        self.assertNotEqual(run.call_args.kwargs['stderr'], subprocess.PIPE)
        xclip.assert_not_called()

    def test_missing_wayland_tools_fail_instead_of_using_xclip(self):
        with patch.object(host_clipboard.shutil, "which", return_value=None), \
                patch.object(host_clipboard, "_xclip_get") as read_x11, \
                patch.object(host_clipboard, "_xclip_set") as write_x11:
            with self.assertRaisesRegex(RuntimeError, "wl-paste is not installed"):
                host_clipboard.get_text()
            with self.assertRaisesRegex(RuntimeError, "wl-copy is not installed"):
                host_clipboard.set_text("secret")
        read_x11.assert_not_called()
        write_x11.assert_not_called()

    def test_explicit_x11_backend_keeps_original_selection_transport(self):
        with patch.dict(os.environ, {"GDK_BACKEND": "x11"}), \
                patch.object(host_clipboard, "_xclip_get", return_value=b"old clipboard") as read, \
                patch.object(host_clipboard, "_xclip_set") as write:
            self.assertEqual(host_clipboard.get_text(), "old clipboard")
            host_clipboard.set_text("new clipboard")
        read.assert_called_once_with("UTF8_STRING")
        write.assert_called_once_with("UTF8_STRING", b"new clipboard")
