"""Keep native editor replacement on the platform's real select-all chord."""
from pathlib import Path
import unittest
from unittest.mock import Mock, call, patch

from tauri_webdriver import NativeSession


class NativeContenteditableTest(unittest.TestCase):
    def session(self):
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "owned-qa"
        session.find = Mock(return_value="editor")
        session.request = Mock(return_value=None)
        session.execute = Mock(side_effect=[True, True])
        session.press_combo = Mock()
        session.type_text = Mock()
        return session

    def test_replacement_uses_platform_mod_on_every_native_webview(self):
        for system in ("Darwin", "Linux", "Windows"):
            with self.subTest(system=system), patch("tauri_webdriver.platform.system", return_value=system):
                session = self.session()
                session.fill(".cm-content", "complete replacement")
                session.press_combo.assert_called_once_with("Mod+a")
                session.type_text.assert_called_once_with("complete replacement")
                self.assertFalse(any(c.args[1].endswith("/value") for c in session.request.call_args_list))

    def test_empty_replacement_selects_then_deletes_without_synthetic_value(self):
        session = self.session()
        session.fill(".cm-content", "")
        self.assertEqual(session.press_combo.call_args_list, [call("Mod+a"), call("Backspace")])
        session.type_text.assert_not_called()


if __name__ == "__main__":
    unittest.main()
