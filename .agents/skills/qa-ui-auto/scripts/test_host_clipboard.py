import os
import subprocess
import unittest
from unittest.mock import patch

from qa_ui_auto import host_clipboard


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
