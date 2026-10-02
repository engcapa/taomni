import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, call

from qa_ui_auto.steps import StepContext, StepError
from qa_ui_auto.steps.mouse import (
    drag_offset, mouse_path_points, step_drag_to, step_mouse_path,
    step_terminal_drag_selection, terminal_selection_args, terminal_selection_points,
)


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

    def test_terminal_drag_starts_in_the_gutter_and_reverses_the_same_endpoints(self):
        box = {"x": 108, "y": 40, "width": 120, "height": 18}
        forward = terminal_selection_points(box, "forward")
        self.assertEqual(forward, ({"x": 104, "y": 49}, {"x": 226, "y": 49}))
        self.assertEqual(terminal_selection_points(box, "reverse"), forward[::-1])
        with self.assertRaisesRegex(StepError, "layout box"):
            terminal_selection_points(None, "forward")
        with self.assertRaisesRegex(StepError, "direction"):
            terminal_selection_args({"selector": "#hit", "direction": "sideways"})
        with self.assertRaisesRegex(StepError, "modifiers"):
            terminal_selection_args({"selector": "#hit", "modifiers": ["Super"]})

    def test_browser_terminal_drag_records_geometry_and_releases_block_modifiers(self):
        ctx, page, locator = self.context()
        locator.bounding_box.return_value = {"x": 108, "y": 40, "width": 120, "height": 18}
        with TemporaryDirectory() as directory:
            ctx.case_dir = Path(directory)
            step_terminal_drag_selection(ctx, {"selector": "#hit", "modifiers": ["Control", "Shift"]})
            record = json.loads((ctx.case_dir / "terminal-selection-drags.json").read_text())[0]
        self.assertEqual(record["start"], {"x": 104, "y": 49})
        self.assertEqual(page.mouse.mock_calls, [call.move(x=104, y=49), call.down(),
                                               call.move(x=226, y=49, steps=8), call.up()])
        self.assertEqual(page.keyboard.mock_calls, [call.down("Control"), call.down("Shift"),
                                                  call.up("Shift"), call.up("Control")])

    def test_browser_terminal_drag_releases_inputs_when_pointer_movement_fails(self):
        ctx, page, _ = self.context()
        page.mouse.move.side_effect = [None, RuntimeError("pointer failure")]
        with self.assertRaisesRegex(RuntimeError, "pointer failure"):
            step_terminal_drag_selection(ctx, {"selector": "#hit", "modifiers": ["Shift"]})
        page.mouse.up.assert_called_once_with()
        page.keyboard.up.assert_called_once_with("Shift")

    def native_terminal_context(self, directory: str) -> SimpleNamespace:
        session = Mock()
        session.find.return_value = "highlight-element"
        session.execute.return_value = {"x": 108, "y": 40, "width": 120, "height": 18}
        session.endpoint.return_value = "/session/qa/actions"
        session.MODIFIER_MAP = {"Control": "\ue009", "Shift": "\ue008"}
        return SimpleNamespace(session=session, case_dir=Path(directory))

    def test_native_terminal_drag_uses_element_offsets_and_synchronised_modifiers(self):
        from qa_ui_auto.native_steps import _terminal_drag_selection

        with TemporaryDirectory() as directory:
            ctx = self.native_terminal_context(directory)
            _terminal_drag_selection(ctx, {"selector": "#hit", "direction": "reverse",
                                           "modifiers": ["Control", "Shift"]})
            actions = ctx.session.request.call_args_list[0].args[2]["actions"]
        keys, pointer = actions
        self.assertEqual(len(keys["actions"]), len(pointer["actions"]))
        self.assertEqual(keys["actions"][:2], [{"type": "keyDown", "value": "\ue009"},
                                               {"type": "keyDown", "value": "\ue008"}])
        moves = [a for a in pointer["actions"] if a["type"] == "pointerMove"]
        self.assertEqual([(m["x"], m["y"]) for m in moves], [(58, 0), (-64, 0)])
        self.assertTrue(all(m["origin"] == {"element-6066-11e4-a52e-4f735466cecf": "highlight-element"} for m in moves))
        self.assertEqual(ctx.session.request.call_args_list[-1], call("DELETE", "/session/qa/actions"))

    def test_native_terminal_drag_releases_inputs_when_driver_fails(self):
        from qa_ui_auto.native_steps import _terminal_drag_selection

        with TemporaryDirectory() as directory:
            ctx = self.native_terminal_context(directory)
            ctx.session.request.side_effect = [RuntimeError("driver failure"), None]
            with self.assertRaisesRegex(RuntimeError, "driver failure"):
                _terminal_drag_selection(ctx, {"selector": "#hit"})
            self.assertEqual(ctx.session.request.call_args_list[-1], call("DELETE", "/session/qa/actions"))
