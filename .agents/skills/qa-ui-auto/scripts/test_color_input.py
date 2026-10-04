from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock
from qa_ui_auto.steps.keyboard import step_fill
from qa_ui_auto.steps import StepError

class ColorInputTest(TestCase):
    def test_color_dispatches_normal_events_and_preserves_literal_value(self):
        locator = Mock()
        locator.first = locator
        locator.get_attribute.return_value = 'color'
        ctx = SimpleNamespace(page=Mock(), dry_run=False)
        ctx.page.locator.return_value = locator
        step_fill(ctx, {'selector': '#color', 'value': '#123456'})
        script, value = locator.evaluate.call_args.args
        self.assertEqual(value, '#123456')
        self.assertIn("new Event('input'", script)
        self.assertIn("new Event('change'", script)
        locator.fill.assert_not_called()
        with self.assertRaises(StepError):
            step_fill(ctx, {'selector': '#color', 'value': '#bad'})
        self.assertEqual(locator.evaluate.call_count, 1)

    def test_text_and_dry_run_keep_existing_behavior(self):
        locator = Mock()
        locator.first = locator
        locator.get_attribute.return_value = 'text'
        ctx = SimpleNamespace(page=Mock(), dry_run=False)
        ctx.page.locator.return_value = locator
        step_fill(ctx, {'selector': '#text', 'value': 'normal text'})
        locator.fill.assert_called_once_with('normal text')
        ctx.dry_run = True
        step_fill(ctx, {'selector': '#text', 'value': 'another'})
        self.assertEqual(locator.fill.call_count, 1)
