from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, call

from qa_ui_auto.steps import StepContext, StepError
from qa_ui_auto.steps.mouse import drag_offset, mouse_path_points, step_drag_to, step_mouse_path


class MouseStepsTest(TestCase):
    def context(self) -> tuple[StepContext, Mock, Mock]:
        page = Mock()
        locator = Mock()
        locator.bounding_box.return_value = {"x": 100, "y": 40, "width": 6, "height": 20}
        page.locator.return_value.first = locator
        return StepContext(page, "TC-mouse", Path("."), {}, {}), page, locator

    def test_drag_to_target_keeps_the_playwright_drag(self):
        ctx, page, locator = self.context()
        step_drag_to(ctx, {"from": "#a", "to": "#b"})
        self.assertEqual([c.args[0] for c in page.locator.call_args_list], ["#a", "#b"])
        locator.drag_to.assert_called_once()
        page.mouse.down.assert_not_called()

    def test_drag_by_offset_moves_from_the_centre_without_a_target(self):
        ctx, page, locator = self.context()
        step_drag_to(ctx, {"from": "#handle", "by": {"dx": 60, "steps": 5}})
        page.locator.assert_called_once_with("#handle")
        locator.scroll_into_view_if_needed.assert_called_once_with()
        locator.drag_to.assert_not_called()
        self.assertEqual(page.mouse.mock_calls, [
            call.move(103.0, 50.0),
            call.down(),
            call.move(163.0, 50.0, steps=5),
            call.up(),
        ])

    def test_drag_offset_validates_its_shape(self):
        self.assertIsNone(drag_offset({"from": "#a", "to": "#b"}))
        self.assertEqual(drag_offset({"from": "#a", "by": {"dx": -4, "dy": 2}}), (-4.0, 2.0, 8))
        with self.assertRaisesRegex(StepError, "needs"):
            drag_offset({"from": "#a", "by": {"dy": 2}})

    def test_drag_by_offset_requires_a_layout_box(self):
        ctx, page, locator = self.context()
        locator.bounding_box.return_value = None
        with self.assertRaisesRegex(StepError, "no layout box"):
            step_drag_to(ctx, {"from": "#hidden", "by": {"dx": 10}})
        page.mouse.down.assert_not_called()

    def test_mouse_path_moves_through_element_relative_points(self):
        ctx, page, _ = self.context()
        step_mouse_path(ctx, {"points": [{"selector": "#doc", "dx": 4, "dy": -2, "steps": 3, "pause_ms": 50}]})
        page.mouse.move.assert_called_once_with(107.0, 48.0, steps=3)
        page.wait_for_timeout.assert_called_once_with(50)
        with self.assertRaisesRegex(StepError, "selector"):
            mouse_path_points({"points": [{"dx": 1}]})
