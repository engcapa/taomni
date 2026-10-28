from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from qa_ui_auto.fixtures.rdp_clipboard_diagnostic import owned_pid, setup


class ClipboardDiagnosticTest(unittest.TestCase):
    def test_sampling_selects_only_the_exact_verified_executable(self):
        app = Path("/tmp/owned qa/taomni")
        with patch("subprocess.check_output", return_value=(
            "12 /tmp/production/taomni\n13 /tmp/owned qa/taomni\n14 /usr/bin/sample\n"
        )):
            self.assertEqual(owned_pid(app), 13)

    def test_missing_or_ambiguous_owner_is_rejected(self):
        for text in ["12 /tmp/production/taomni", "13 /tmp/qa/taomni\n14 /tmp/qa/taomni"]:
            with self.subTest(text=text), patch("subprocess.check_output", return_value=text):
                with self.assertRaises(RuntimeError):
                    owned_pid(Path("/tmp/qa/taomni"))

    def test_other_platforms_have_no_side_effects(self):
        with patch("platform.system", return_value="Linux"), patch("subprocess.check_output") as command:
            setup(SimpleNamespace())
            command.assert_not_called()

    def test_non_qa_identity_is_rejected_before_sampling(self):
        with patch("platform.system", return_value="Darwin"), \
             patch("tauri_webdriver.native_binary", return_value=Path("/tmp/production/taomni")), \
             patch("native_build.verify_identity", return_value={"identifier": "com.taomni.app"}), \
             patch("subprocess.check_output") as command:
            with self.assertRaisesRegex(RuntimeError, "verified isolated QA"):
                setup(SimpleNamespace(cfg={}))
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
