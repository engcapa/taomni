import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock

from qa_ui_auto.control_coverage import INTERACTIVE_VERBS, _selectors_in_step
from qa_ui_auto.steps import StepContext, StepError
from qa_ui_auto.steps.mouse import step_drag_path


class DragPathTest(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.page = Mock()
        self.page.locator.return_value.first.bounding_box.return_value = {
            "x": 10, "y": 20, "width": 400, "height": 300,
        }
        self.ctx = StepContext(self.page, "TC-PATH", Path(self.tmp.name), {}, {})
        self.args = {"selector": "canvas", "points": [{"x": 30, "y": 40}, {"x": 80, "y": 90}, {"x": 20, "y": 70}]}

    def test_uses_element_relative_points_and_always_releases(self):
        step_drag_path(self.ctx, self.args)
        self.assertEqual(self.page.mouse.move.call_args_list[0].args, (40, 60))
        self.assertEqual(self.page.mouse.move.call_args_list[-1].args, (30, 90))
        self.page.mouse.down.assert_called_once_with()
        self.page.mouse.up.assert_called_once_with()
        self.page.mouse.reset_mock()
        self.page.mouse.move.side_effect = [None, RuntimeError("disconnected")]
        with self.assertRaisesRegex(RuntimeError, "disconnected"):
            step_drag_path(self.ctx, self.args)
        self.page.mouse.up.assert_called_once_with()

    def test_rejects_invalid_or_outside_points_before_mouse_down(self):
        for points in ([{"x": 0, "y": 0}], [{"x": True, "y": 0}] * 2,
                       [{"x": float("nan"), "y": 0}] * 2,
                       [{"x": 401, "y": 10}, {"x": 10, "y": 20}]):
            with self.subTest(points=points), self.assertRaises(StepError):
                step_drag_path(self.ctx, {"selector": "canvas", "points": points})
        self.page.mouse.down.assert_not_called()

    def test_dry_run_and_control_coverage(self):
        self.ctx.dry_run = True
        step_drag_path(self.ctx, self.args)
        self.page.locator.assert_not_called()
        self.assertIn("drag_path", INTERACTIVE_VERBS)
        self.assertEqual(_selectors_in_step("drag_path", self.args), ["canvas"])
