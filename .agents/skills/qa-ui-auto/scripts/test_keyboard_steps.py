from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock

from qa_ui_auto.steps import StepContext, StepError
from qa_ui_auto.steps.keyboard import step_blur, step_send_keys, step_terminal_input, step_type


class KeyboardStepsTest(TestCase):
    def context(self) -> tuple[StepContext, Mock, Mock]:
        page = Mock()
        locator = Mock()
        locator.evaluate.return_value = True
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

    def test_terminal_input_dispatches_xterm_data_and_submit(self):
        ctx, page, locator = self.context()
        step_terminal_input(ctx, {
            "selector": ".xterm-helper-textarea",
            "text": "echo ready",
            "submit": True,
        })
        self.assertEqual([c.args[0] for c in locator.press.call_args_list], ["Shift", "Enter"])
        script, payload = locator.evaluate.call_args.args
        self.assertIn("new InputEvent", script)
        self.assertEqual(payload, {"text": "echo ready", "submit": True})

    def test_blur_removes_focus_from_the_control(self):
        ctx, _, locator = self.context()
        locator.evaluate.return_value = True
        step_blur(ctx, 'input[aria-label="Terminal font size"]')
        script = locator.evaluate.call_args.args[0]
        self.assertIn("blur()", script)

    def test_blur_rejects_a_malformed_selector(self):
        ctx, _, locator = self.context()
        with self.assertRaisesRegex(StepError, "non-empty selector"):
            step_blur(ctx, "")
        locator.evaluate.assert_not_called()

    def test_blur_reports_a_control_that_kept_focus(self):
        ctx, _, locator = self.context()
        locator.evaluate.return_value = False
        with self.assertRaisesRegex(StepError, "kept focus"):
            step_blur(ctx, "#locked")

    def test_terminal_input_rejects_non_boolean_submit(self):
        ctx, _, locator = self.context()
        with self.assertRaisesRegex(StepError, "submit must be a boolean"):
            step_terminal_input(ctx, {
                "selector": ".xterm-helper-textarea",
                "text": "echo ready",
                "submit": "yes",
            })
        locator.evaluate.assert_not_called()

    def test_terminal_input_without_submit_preserves_draft(self):
        ctx, _, locator = self.context()
        step_terminal_input(ctx, {"selector": ".xterm-helper-textarea", "text": "draft"})
        locator.press.assert_called_once_with("Shift")

    def test_terminal_input_retries_a_probe_until_its_output_appears(self):
        ctx, page, locator = self.context()
        pane = Mock()
        pane.text_content.return_value = ""

        def _attribute(name):
            self.assertEqual(name, "data-terminal-text")
            # Nothing on screen until the probe has been dispatched twice.
            return "ready\n" if locator.evaluate.call_count > 1 else ""

        pane.get_attribute.side_effect = _attribute
        page.locator.side_effect = lambda selector: Mock(first=pane if selector == "#pane" else locator)
        step_terminal_input(ctx, {
            "selector": ".xterm-helper-textarea",
            "text": "echo ready",
            "submit": True,
            "verify": {
                "selector": "#pane",
                "regex": r"(?m)^ready\r?$",
                "timeout_sec": 0.1,
                "attempts": 2,
            },
        })
        self.assertEqual(locator.evaluate.call_count, 2)
        self.assertEqual([c.args[0] for c in locator.press.call_args_list], ["Shift", "Enter", "Shift", "Enter"])

    def test_terminal_input_reports_a_probe_that_never_appears(self):
        ctx, page, locator = self.context()
        pane = Mock()
        pane.text_content.return_value = ""
        pane.get_attribute.return_value = ""
        page.locator.side_effect = lambda selector: Mock(first=pane if selector == "#pane" else locator)
        with self.assertRaisesRegex(StepError, "after 2 attempt"):
            step_terminal_input(ctx, {
                "selector": ".xterm-helper-textarea",
                "text": "echo ready",
                "submit": True,
                "verify": {
                    "selector": "#pane",
                    "regex": r"(?m)^ready\r?$",
                    "timeout_sec": 0.2,
                    "attempts": 2,
                },
            })
        self.assertEqual(locator.evaluate.call_count, 2)

    def test_terminal_input_rejects_a_malformed_verify_block(self):
        ctx, _, locator = self.context()
        with self.assertRaisesRegex(StepError, "verify expects"):
            step_terminal_input(ctx, {
                "selector": ".x",
                "text": "t",
                "verify": {"selector": "#pane", "regex": "^ready$", "bogus": 1},
            })
        with self.assertRaisesRegex(StepError, "verify regex"):
            step_terminal_input(ctx, {"selector": ".x", "text": "t", "verify": {"selector": "#pane"}})
        locator.evaluate.assert_not_called()


if __name__ == "__main__":
    import unittest

    unittest.main()
