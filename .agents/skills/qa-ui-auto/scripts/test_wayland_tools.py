import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from ci_wayland_portal import owned_portal, owned_process, consent_kind
from ci_wayland_input import focus_window, move_pointer, owned_window_pid
from qa_ui_auto import host_clipboard, wayland
from qa_ui_auto.native_steps import _read_wayland_clipboard


class WaylandToolsTests(unittest.TestCase):
    def test_named_window_retains_executable_runtime_and_uniqueness_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'taomni-qa'
            executable.touch()
            owned_runtime = root / 'qa-owned'
            for pid, runtime in ((42, str(owned_runtime)), (43, str(root / 'personal'))):
                process = root / str(pid)
                process.mkdir()
                (process / 'environ').write_bytes(('XDG_RUNTIME_DIR=' + runtime + '\0').encode())
            windows = [dict(pid=42, title='Main'), dict(pid=42, title='Pinned Screenshot'),
                       dict(pid=43, title='Other')]
            with patch.object(Path, 'resolve', return_value=executable):
                self.assertEqual(owned_window_pid(windows, executable, owned_runtime,
                                                 root, title='Pinned Screenshot'), 42)
                for title in ('Other', 'Missing'):
                    with self.assertRaisesRegex(RuntimeError, 'found 0'):
                        owned_window_pid(windows, executable, owned_runtime, root, title=title)
                with self.assertRaisesRegex(RuntimeError, 'found 2'):
                    owned_window_pid(windows, executable, owned_runtime, root)
                with self.assertRaisesRegex(RuntimeError, 'found 2'):
                    owned_window_pid(windows + [windows[1]], executable, owned_runtime,
                                     root, title='Pinned Screenshot')
            def resolve(path, **kwargs):
                return root / 'other-app' if path.name == 'exe' else executable
            with patch.object(Path, 'resolve', resolve):
                with self.assertRaisesRegex(RuntimeError, 'found 0'):
                    owned_window_pid(windows, executable, owned_runtime, root,
                                     title='Pinned Screenshot')

    def test_consent_only_accepts_known_dialogs_from_their_owning_process(self):
        def records(name, showing=True):
            return [{"name": name, "showing": showing}]
        self.assertEqual(consent_kind("gnome-shell", records("Allow Apps to Take Screenshots?")), "screenshot-access")
        self.assertEqual(consent_kind("xdg-desktop-portal-gnome", records("Screenshot")), "portal")
        self.assertEqual(consent_kind("xdg-desktop-portal-gnome", records("Remote Desktop")), "portal")
        self.assertIsNone(consent_kind("gnome-shell", records("Allow Apps to Use the Microphone?")))
        self.assertIsNone(consent_kind("other-process", records("Screenshot")))
        self.assertIsNone(consent_kind("gnome-shell", records("Allow Apps to Take Screenshots?", False)))

    def test_pointer_waits_for_queued_motion_and_rejects_a_nonmoving_device(self):
        evaluate = Mock(side_effect=[[0, 0], [0, 0], [24, 18]])
        notify = Mock()
        with patch("ci_wayland_input.time.sleep"):
            self.assertEqual(move_pointer(evaluate, notify, 24, 18), [24, 18])
        self.assertEqual(notify.call_count, 2)
        with patch("ci_wayland_input.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "did not reach"):
                move_pointer(Mock(return_value=[0, 0]), notify, 24, 18)

    def test_fixture_readiness_waits_for_os_focus_and_reports_real_geometry(self):
        rect = {"x": 120, "y": 80, "width": 600, "height": 400}
        window = {"pid": 42, "focused": True, "frame": rect}
        evaluate = Mock(side_effect=[True,
            {"overview": True, "windows": [window]},
            {"overview": False, "windows": [window]}])
        diagnostics = {}
        with patch("ci_wayland_input.time.sleep"):
            self.assertEqual(focus_window(evaluate, 42, diagnostics)["frame"], rect)
        self.assertEqual(evaluate.call_count, 3)
        self.assertFalse(diagnostics["after"]["overview"])

    def test_portal_automation_rejects_other_runtime_and_non_portal_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "xdg-desktop-portal-gnome"
            binary.touch()
            process = root / "42"
            process.mkdir()
            # /proc/PID/exe resolves to the actual executable. Avoid symlink
            # privileges on the Windows test host by patching only that read.
            (process / "environ").write_bytes(b"XDG_RUNTIME_DIR=/tmp/qa-owned\0")
            with patch.object(Path, "resolve", return_value=binary):
                self.assertTrue(owned_portal(42, "/tmp/qa-owned", root))
                self.assertFalse(owned_portal(42, "/tmp/personal", root))
                self.assertFalse(owned_portal(43, "/tmp/qa-owned", root))
            with patch.object(Path, "resolve", return_value=root / "other-app"):
                self.assertFalse(owned_portal(42, "/tmp/qa-owned", root))
            with patch.object(Path, "resolve", return_value=root / "gnome-shell"):
                self.assertTrue(owned_process(42, "/tmp/qa-owned", "gnome-shell", root))
                self.assertFalse(owned_process(42, "/tmp/personal", "gnome-shell", root))

    def test_missing_owned_socket_fails_without_x11_fallback(self):
        with patch.dict(os.environ, {"GDK_BACKEND": "wayland"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "owned desktop input socket"):
                wayland.command("keys", chords=[[65]])

    def test_invalid_external_utf8_is_a_real_conversion_failure(self):
        with patch("qa_ui_auto.native_steps.subprocess.run", return_value=Mock(stdout=b"\xff")) as run:
            self.assertFalse(_read_wayland_clipboard()["ok"])
            self.assertEqual(run.call_args.args[0][0], "wl-paste")
        with patch("qa_ui_auto.native_steps.subprocess.run", return_value=Mock(stdout="中文\n".encode())):
            self.assertEqual(_read_wayland_clipboard(), {"ok": True, "text": "中文\n"})

    def test_wayland_clipboard_image_oracle_retains_exact_png_bytes(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, {"GDK_BACKEND": "wayland", "WAYLAND_DISPLAY": "wayland-qa"}), \
             patch.object(host_clipboard, "SYSTEM", "Linux"), \
             patch.object(host_clipboard, "_run", return_value=b"\x89PNG\r\n\x00\xff") as run, \
             patch.object(host_clipboard, "_xclip_get") as x11:
            target = Path(directory) / "image.png"
            host_clipboard.save_image(target)
            self.assertEqual(target.read_bytes(), b"\x89PNG\r\n\x00\xff")
            self.assertIn("image/png", run.call_args.args[0])
            x11.assert_not_called()

    def test_clipboard_quiet_counts_ownership_notifications_even_for_identical_payloads(self):
        with patch.dict(os.environ, {"GDK_BACKEND": "wayland", "WAYLAND_DISPLAY": "wayland-qa"}), \
             patch.object(host_clipboard, "SYSTEM", "Linux"), \
             patch("qa_ui_auto.wayland.command", side_effect=[12, 15]) as command, \
             patch.object(host_clipboard.time, "sleep"), \
             patch.object(host_clipboard, "get_text") as read:
            self.assertEqual(host_clipboard.count_changes(1), 3)
            read.assert_not_called()
            self.assertEqual(command.call_count, 2)


if __name__ == "__main__":
    unittest.main()
