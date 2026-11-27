"""Native reload must observe document replacement before subsequent actions."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from qa_ui_auto.native_reload import reload_window
from qa_ui_auto.steps import StepError
from tauri_webdriver import WebDriverError


class NativeReloadTests(unittest.TestCase):
    def test_waits_through_old_shell_and_navigation_until_new_document(self):
        session = Mock()
        session.execute.side_effect = [True, False, WebDriverError("navigation"), False, True]
        with patch("qa_ui_auto.native_reload.time.sleep"):
            reload_window(SimpleNamespace(session=session))
        self.assertEqual(session.execute.call_count, 5)
        session.activate_linux_window.assert_called_once()
        session.install_console_hook.assert_called_once()

    def test_detached_reload_waits_for_its_own_route(self):
        session = Mock()
        session.execute.side_effect = [True, False, True]
        with patch("qa_ui_auto.native_reload.time.sleep"):
            reload_window(SimpleNamespace(session=session), ready_selector='main [role="status"]')
        readiness = session.execute.call_args.args[0]
        self.assertIn('main [role=', readiness)
        self.assertNotIn('welcome-panel', readiness)
        self.assertIn('__QA_UI_AUTO_RELOAD_PENDING__ !== true', readiness)

    def test_never_installs_hook_or_reports_success_on_the_old_document(self):
        session = Mock()
        session.execute.side_effect = [True, False]
        with patch("qa_ui_auto.native_reload.time.monotonic", side_effect=[0, 0, 1, 2]), \
                patch("qa_ui_auto.native_reload.time.sleep"), \
                self.assertRaisesRegex(StepError, "new document did not mount"):
            reload_window(SimpleNamespace(session=session), timeout_sec=1)
        session.activate_linux_window.assert_not_called()
        session.install_console_hook.assert_not_called()


if __name__ == "__main__":
    unittest.main()
