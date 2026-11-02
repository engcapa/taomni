"""Native-close requests must stay inside the verified QA launcher's ownership."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from native_webdriver_transport import WebDriverError
from native_window_close_x11 import (
    close_x11_application_window, managed_windows, owned_application_pid, x11_window_closed,
)


class OwnedX11CloseTest(unittest.TestCase):
    def test_executable_and_kernel_birth_identity_both_have_to_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            application = root / "qa-app"
            foreign = root / "foreign-app"
            application.touch()
            foreign.touch()
            for pid, executable, started, state in (
                (100, application, "1000", "S"),
                (101, foreign, "1001", "S"),
                (102, application, "changed", "S"),
                (103, application, "1003", "Z"),
            ):
                entry = root / str(pid)
                entry.mkdir()
                (entry / "exe").symlink_to(executable)
                fields = [state, "0", "50"] + ["0"] * 16 + [started]
                (entry / "stat").write_text(f"{pid} (app with spaces) " + " ".join(fields))
            identities = {100: "1000", 101: "1001", 102: "1002", 103: "1003", 104: "1004"}
            self.assertEqual(owned_application_pid(application, identities, root), 100)
            with self.assertRaisesRegex(WebDriverError, "No unique live"):
                owned_application_pid(application, {102: "1002"}, root)
            (root / "103" / "stat").write_text("103 (qa-app) " + " ".join(
                ["S", "0", "50"] + ["0"] * 16 + ["1003"]))
            with self.assertRaisesRegex(WebDriverError, "No unique live"):
                owned_application_pid(application, identities, root)

    def test_normal_close_targets_exact_owned_native_window_not_a_title(self):
        windows = "0x00000012 0 900 host Taomni QA\n0x00000abc 0 123 host Any title\n"
        with patch("native_window_close_x11.owned_application_pid", return_value=123) as owner, \
                patch("native_window_close_x11.subprocess.run", return_value=subprocess.CompletedProcess([], 0, windows, "")) as run:
            result = close_x11_application_window(Path("qa-app"), {123: "birth"})
        self.assertEqual(owner.call_count, 2)
        self.assertEqual(run.call_args_list[0].args[0], ["wmctrl", "-lp"])
        self.assertEqual(run.call_args_list[1].args[0], ["wmctrl", "-ic", "0xabc"])
        self.assertEqual(result["pid"], 123)
        self.assertEqual(result["window_id"], "0xabc")
        self.assertFalse(result["window_closed"])

    def test_missing_or_ambiguous_window_never_sends_input(self):
        for windows in ([], [("0x1", 123), ("0x2", 123)], [("0x1", 999)]):
            with self.subTest(windows=windows), \
                    patch("native_window_close_x11.owned_application_pid", return_value=123), \
                    patch("native_window_close_x11.managed_windows", return_value=windows), \
                    patch("native_window_close_x11.subprocess.run") as run:
                with self.assertRaisesRegex(WebDriverError, "No unique managed"):
                    close_x11_application_window(Path("qa-app"), {123: "birth"})
                run.assert_not_called()

    def test_changed_owner_before_dispatch_never_sends_input(self):
        with patch("native_window_close_x11.owned_application_pid", side_effect=[123, 456]), \
                patch("native_window_close_x11.managed_windows", return_value=[("0x1", 123)]), \
                patch("native_window_close_x11.subprocess.run") as run:
            with self.assertRaisesRegex(WebDriverError, "ownership changed"):
                close_x11_application_window(Path("qa-app"), {123: "birth"})
            run.assert_not_called()

    def test_native_surface_disappearance_is_observed_without_input(self):
        observation = {"window_id": "0x123", "pid": 123}
        with patch("native_window_close_x11.managed_windows", side_effect=[
                [("0x123", 123)], [("0x123", 456)], [("0x456", 123)]]), \
                patch("native_window_close_x11.subprocess.run") as run:
            self.assertFalse(x11_window_closed(observation))
            self.assertFalse(x11_window_closed(observation))
            self.assertTrue(x11_window_closed(observation))
            self.assertTrue(observation["window_closed"])
            run.assert_not_called()

    def test_malformed_window_listing_and_command_failure_stay_failed(self):
        for text in ("unexpected", "not-an-id 0 123 host title", "0x1 0 invalid host title"):
            with self.subTest(text=text), patch("native_window_close_x11.subprocess.run",
                    return_value=subprocess.CompletedProcess([], 0, text, "")):
                with self.assertRaisesRegex(WebDriverError, "Malformed X11"):
                    managed_windows()
        with patch("native_window_close_x11.subprocess.run",
                   side_effect=subprocess.CalledProcessError(1, "wmctrl")):
            with self.assertRaises(subprocess.CalledProcessError):
                managed_windows()


if __name__ == "__main__":
    unittest.main()
