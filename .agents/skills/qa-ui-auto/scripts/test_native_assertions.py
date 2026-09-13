from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.native_steps import run_native_step
from qa_ui_auto.steps import StepError


class NativeAssertionsTest(TestCase):
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
