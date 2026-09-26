from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.native_steps import run_native_step
from qa_ui_auto.steps import StepError


class NativeAssertionsTest(TestCase):
    def test_checkbox_requires_real_input_and_observed_transition(self):
        ctx = Mock()
        ctx.session.execute.return_value = None
        with self.assertRaisesRegex(StepError, "missing checkbox"):
            run_native_step(ctx, "set_check", {"selector": "#check", "checked": False})
        ctx.session.click.assert_not_called()
        ctx.session.execute.side_effect = [False, False]
        with self.assertRaisesRegex(StepError, "did not become"):
            run_native_step(ctx, "set_check", {"selector": "#check", "checked": True})
        ctx.session.execute.side_effect = [False, True]
        run_native_step(ctx, "set_check", {"selector": "#check", "checked": True})

    def test_menu_click_uses_webdriver_and_rejects_ambiguous_label(self):
        ctx = Mock()
        ctx.session.execute.return_value = None
        with self.assertRaisesRegex(StepError, "one visible exact"):
            run_native_step(ctx, "click_menu", "Local History")
        ctx.session.request.assert_not_called()
        ctx.session.execute.return_value = {"element-6066-11e4-a52e-4f735466cecf": "menu-leaf"}
        ctx.session.element_path.return_value = "/session/test/element/menu-leaf/click"
        run_native_step(ctx, "click_menu", "Local History")
        ctx.session.request.assert_called_once_with("POST", "/session/test/element/menu-leaf/click", {})

    def test_count_checks_all_bounds_and_requires_a_bound(self):
        ctx = Mock()
        ctx.session.count.return_value = 2
        run_native_step(ctx, "assert_count", {"selector": ".tab", "equal": 2, "min": 1, "max": 2})
        for bounds in ({}, {"equal": 1}, {"min": 3}, {"max": 1}, {"equal": 2, "max": 1}):
            with self.subTest(bounds=bounds), self.assertRaises(StepError):
                run_native_step(ctx, "assert_count", {"selector": ".tab", **bounds})

    def test_menu_waits_for_labels_and_rejects_missing_items(self):
        ctx = Mock()
        ctx.session.execute.side_effect = [[], ["Open", "Rename..."]]
        with patch("qa_ui_auto.native_assertions.time.sleep"):
            run_native_step(ctx, "assert_menu_items", ["Open", "Rename..."])
        ctx.session.execute.side_effect = None
        ctx.session.execute.return_value = ["Open"]
        with patch("qa_ui_auto.native_assertions.time.time", side_effect=[0, 1, 11]), \
             patch("qa_ui_auto.native_assertions.time.sleep"), \
             self.assertRaisesRegex(StepError, "Delete"):
            run_native_step(ctx, "assert_menu_items", ["Delete"])

    def test_right_click_options_are_not_silently_dropped(self):
        ctx = Mock()
        for option in ("modifiers", "position", "force"):
            with self.subTest(option=option), self.assertRaises(StepError):
                run_native_step(ctx, "right_click", {"selector": "#row", option: True})
        ctx.session.right_click.assert_not_called()
        run_native_step(ctx, "right_click", "#row")
        ctx.session.right_click.assert_called_once_with("#row")

    def test_type_can_focus_an_explicit_target_before_input(self):
        ctx = Mock()
        ctx.session.type_text.return_value = "typed"
        result = run_native_step(
            ctx,
            "type",
            {"selector": ".xterm-helper-textarea", "text": "whoami"},
        )
        self.assertEqual(result, "typed")
        ctx.session.focus.assert_called_once_with(".xterm-helper-textarea")
        ctx.session.type_text.assert_called_once_with("whoami")

    def test_type_rejects_malformed_rich_arguments(self):
        ctx = Mock()
        with self.assertRaisesRegex(StepError, "expected string"):
            run_native_step(ctx, "send_keys", {"selector": "#terminal"})
        ctx.session.focus.assert_not_called()
        ctx.session.type_text.assert_not_called()

    def test_terminal_input_dispatches_xterm_data_and_submit(self):
        ctx = Mock()
        ctx.session.execute.return_value = {"found": True, "focused": True}
        result = run_native_step(ctx, "terminal_input", {
            "selector": ".xterm-helper-textarea",
            "text": "echo ready",
            "submit": True,
        })
        script = ctx.session.execute.call_args.args[0]
        self.assertIn("new InputEvent", script)
        self.assertIn("echo ready", script)
        self.assertEqual([c.args[0] for c in ctx.session.press_combo.call_args_list], ["Shift", "Enter"])
        self.assertEqual(result, "sent 10 chars to xterm input and submitted")

    def test_terminal_input_without_submit_does_not_press_enter(self):
        ctx = Mock()
        ctx.session.execute.return_value = {"found": True, "focused": True}
        run_native_step(ctx, "terminal_input", {"selector": ".xterm-helper-textarea", "text": "draft"})
        ctx.session.press_combo.assert_called_once_with("Shift")

    def test_terminal_input_requires_a_real_target(self):
        ctx = Mock()
        ctx.session.execute.return_value = {"found": False, "focused": False}
        with self.assertRaisesRegex(StepError, "target not found"):
            run_native_step(ctx, "terminal_input", {
                "selector": ".xterm-helper-textarea",
                "text": "echo ready",
            })
        self.assertNotIn("Enter", [c.args[0] for c in ctx.session.press_combo.call_args_list])

    def test_terminal_input_retries_a_probe_until_its_output_appears(self):
        ctx = Mock()
        ctx.session.execute.return_value = {"found": True, "focused": True}
        # Nothing on screen until the probe has been dispatched twice.
        ctx.session.text.side_effect = lambda _selector: (
            "ready\n" if ctx.session.execute.call_count > 1 else ""
        )
        result = run_native_step(ctx, "terminal_input", {
            "selector": ".xterm-helper-textarea",
            "text": "echo ready",
            "submit": True,
            "verify": {
                "selector": "[data-testid=\"terminal-pane\"]",
                "regex": r"(?m)^ready\r?$",
                "timeout_sec": 0.1,
                "attempts": 2,
            },
        })
        self.assertEqual(ctx.session.execute.call_count, 2)
        self.assertEqual(
            [c.args[0] for c in ctx.session.press_combo.call_args_list],
            ["Shift", "Enter", "Shift", "Enter"],
        )
        self.assertEqual(result, "sent 10 chars to xterm input and submitted")

    def test_terminal_input_reports_a_probe_that_never_appears(self):
        ctx = Mock()
        ctx.session.execute.return_value = {"found": True, "focused": True}
        ctx.session.text.return_value = ""
        with self.assertRaisesRegex(StepError, "after 2 attempt"):
            run_native_step(ctx, "terminal_input", {
                "selector": ".xterm-helper-textarea",
                "text": "echo ready",
                "submit": True,
                "verify": {
                    "selector": "[data-testid=\"terminal-pane\"]",
                    "regex": r"(?m)^ready\r?$",
                    "timeout_sec": 0.2,
                    "attempts": 2,
                },
            })
        self.assertEqual(ctx.session.execute.call_count, 2)

    def test_terminal_input_rejects_a_malformed_verify_block(self):
        ctx = Mock()
        with self.assertRaisesRegex(StepError, "verify expects"):
            run_native_step(ctx, "terminal_input", {
                "selector": ".xterm-helper-textarea",
                "text": "echo ready",
                "verify": {"selector": "[data-testid=\"terminal-pane\"]", "regex": "^ready$", "bogus": 1},
            })
        with self.assertRaisesRegex(StepError, "verify regex"):
            run_native_step(ctx, "terminal_input", {
                "selector": ".xterm-helper-textarea",
                "text": "echo ready",
                "verify": {"selector": "[data-testid=\"terminal-pane\"]"},
            })
        ctx.session.execute.assert_not_called()

