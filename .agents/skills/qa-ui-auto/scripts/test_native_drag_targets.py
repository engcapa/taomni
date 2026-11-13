"""Unit contracts for endpoint readiness; these tests do not launch a WebView."""
from unittest import TestCase
from unittest.mock import Mock, call, patch

from native_pointer import TARGET_GEOMETRY
from native_webdriver_transport import WebDriverError
from qa_ui_auto.native_drag_targets import prepare_drag_points
from qa_ui_auto.steps import StepError


class NativeDragTargetsTest(TestCase):
    def setUp(self):
        self.session = Mock(deadline=None)
        self.session.endpoint.side_effect = lambda suffix: "/session/qa" + suffix
        self.session.find.side_effect = lambda selector, **kwargs: selector + "-id"
        self.origin = lambda selector: {"element-6066-11e4-a52e-4f735466cecf": selector + "-id"}

    def test_scrolls_clipped_tree_then_source_and_rechecks_target_before_button_input(self):
        source, target = {"x": 769, "y": 183}, {"x": 405, "y": 600}
        self.session.request.side_effect = [None, None, {**target, "ready": True}]
        with patch("qa_ui_auto.native_drag_targets.prepare_pointer_target", side_effect=[target, source]) as ready:
            result = prepare_drag_points(self.session, {"from": "#file", "to": "#tree"})
        self.assertEqual(result, ((769, 183), (405, 600), 8))
        self.assertEqual(ready.call_args_list, [call(self.session, self.origin("#tree")),
                                               call(self.session, self.origin("#file"))])
        requests = self.session.request.call_args_list
        self.assertTrue(all(item.args[1].endswith("/execute/sync") for item in requests))
        self.assertIn("scrollIntoView", requests[0].args[2]["script"])
        self.assertEqual(requests[0].args[2]["args"], [self.origin("#tree")])
        self.assertEqual(requests[1].args[2]["args"], [self.origin("#file")])
        self.assertEqual(requests[2].args[2], {"script": TARGET_GEOMETRY,
                                              "args": [self.origin("#tree"), False]})
        # Shared readiness requires el.contains(document.elementFromPoint(...)),
        # not just a rect whose centre is somewhere inside the WebView.
        self.assertIn("document.elementFromPoint", TARGET_GEOMETRY)
        self.assertIn("el.contains(hit)", TARGET_GEOMETRY)

    def test_target_covered_by_status_or_shifted_after_source_scroll_is_not_delivered(self):
        for observation in ({"ready": False, "x": 405, "y": 634},
                            {"ready": True, "x": 405, "y": 599}, None):
            with self.subTest(observation=observation):
                self.session.reset_mock()
                self.session.request.side_effect = [None, None, observation]
                with patch("qa_ui_auto.native_drag_targets.prepare_pointer_target", side_effect=[
                        {"x": 405, "y": 600}, {"x": 769, "y": 183}]):
                    with self.assertRaisesRegex(StepError, "both endpoints must remain hit-testable"):
                        prepare_drag_points(self.session, {"from": "#file", "to": "#tree"})
                self.assertTrue(all(item.args[1].endswith("/execute/sync")
                                    for item in self.session.request.call_args_list))

    def test_unreachable_geometry_fails_instead_of_using_old_or_offscreen_rect(self):
        self.session.request.return_value = None
        with patch("qa_ui_auto.native_drag_targets.prepare_pointer_target", side_effect=WebDriverError(
                "native pointer target did not become stable and hit-testable")):
            with self.assertRaisesRegex(StepError, "endpoint preparation failed.*hit-testable"):
                prepare_drag_points(self.session, {"from": "#file", "to": "#hidden"})
        self.assertEqual(self.session.find.call_count, 2)
        self.assertEqual(self.session.request.call_count, 1)

    def test_offset_only_scrolls_source_and_keeps_requested_css_pixel_distance(self):
        with patch("qa_ui_auto.native_drag_targets.prepare_pointer_target", return_value={"x": 23, "y": 35}):
            result = prepare_drag_points(self.session, {"from": "#handle", "by": {"dx": 45, "dy": -4, "steps": 3}})
        self.assertEqual(result, ((23, 35), (68, 31), 3))
        self.session.find.assert_called_once_with("#handle", interactive=False)
        self.assertEqual(self.session.request.call_count, 1)

    def test_nonfinite_offset_fails_before_any_preparation(self):
        for delta in (float("nan"), float("inf")):
            with self.subTest(delta=delta):
                with self.assertRaisesRegex(StepError, "offsets must be finite"):
                    prepare_drag_points(self.session, {"from": "#handle", "by": {"dx": delta}})
        self.session.find.assert_not_called()
        self.session.request.assert_not_called()
