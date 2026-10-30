"""Keep native editor replacement on the platform's real select-all chord."""
from pathlib import Path
import unittest
from unittest.mock import Mock, call, patch

from tauri_webdriver import NativeSession, WebDriverError


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

    def test_keeps_an_already_focused_editor_before_selecting_and_replacing(self):
        session = self.session()
        session.fill(".cm-content", "")
        self.assertFalse(any(c.args[1].endswith("/click") for c in session.request.call_args_list))
        self.assertEqual(session.press_combo.call_args_list, [call("Mod+a"), call("Backspace")])

    def test_unfocused_editor_still_gets_a_real_click_and_focus_verification(self):
        session = self.session()
        session.execute.side_effect = [True, False, True]
        session.fill(".cm-content", "replacement")
        clicks = [c for c in session.request.call_args_list if c.args[1].endswith("/click")]
        self.assertEqual(len(clicks), 1)
        session.type_text.assert_called_once_with("replacement")

    def test_failed_focus_retries_are_bounded_and_never_type_into_another_owner(self):
        session = self.session()
        session.execute.side_effect = [True, False, False, False, False]
        with patch("native_contenteditable.time.sleep"), self.assertRaisesRegex(WebDriverError, "did not receive focus"):
            session.fill(".cm-content", "replacement")
        clicks = [c for c in session.request.call_args_list if c.args[1].endswith("/click")]
        self.assertEqual(len(clicks), 3)
        session.press_combo.assert_not_called()
        session.type_text.assert_not_called()


if __name__ == "__main__":
    unittest.main()
