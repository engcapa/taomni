from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock

from qa_ui_auto.steps import StepContext, StepError
from qa_ui_auto.steps.keyboard import step_send_keys, step_type


class KeyboardStepsTest(TestCase):
    def context(self) -> tuple[StepContext, Mock, Mock]:
        page = Mock()
        locator = Mock()
        page.locator.return_value.first = locator
        return StepContext(page, "TC-keyboard", Path("."), {}, {}), page, locator

    def test_type_can_focus_an_explicit_target_before_input(self):
        ctx, page, locator = self.context()
        step_type(ctx, {"selector": ".xterm-helper-textarea", "text": "whoami"})
        page.locator.assert_called_once_with(".xterm-helper-textarea")
        locator.focus.assert_called_once_with()
        page.keyboard.type.assert_called_once_with("whoami")

    def test_send_keys_preserves_string_short_form(self):
        ctx, page, _ = self.context()
        step_send_keys(ctx, "whoami")
        page.locator.assert_not_called()
        page.keyboard.type.assert_called_once_with("whoami")

    def test_type_rejects_malformed_rich_arguments(self):
        ctx, page, _ = self.context()
        with self.assertRaisesRegex(StepError, "expected string"):
            step_type(ctx, {"selector": "#terminal"})
        page.keyboard.type.assert_not_called()


if __name__ == "__main__":
    import unittest

    unittest.main()
