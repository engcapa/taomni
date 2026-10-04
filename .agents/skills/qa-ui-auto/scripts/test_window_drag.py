import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.steps import StepError
from qa_ui_auto.behavior_contract import is_check
from qa_ui_auto.testcase import load_case
from qa_ui_auto.verification import native_support
from qa_ui_auto.window_drag import run_window_drag, validate_movement


class WindowDragTest(TestCase):
    def test_main_rail_cases_validate_and_declare_native_platform_boundaries(self):
        cases = [load_case(path) for path in Path("qa-ui-auto-tests/cases").glob("TC-MAIN-RAIL-*.yaml")]
        self.assertTrue({"TC-MAIN-RAIL-01", "TC-MAIN-RAIL-02", "TC-MAIN-RAIL-03"}
                        .issubset({case.id for case in cases}))
        for case in cases:
            if "native" in case.modes:
                self.assertIsNone(native_support(case, "Linux"))
                if case.id == "TC-MAIN-RAIL-01":
                    self.assertIsNone(native_support(case, "macOS"))
                else:
                    self.assertIsNotNone(native_support(case, "macOS"))

    def test_only_movement_with_an_independent_postcondition_is_a_contract_check(self):
        self.assertTrue(is_check({"native_window_drag": {"dx": 24, "dy": 18}}))
        self.assertFalse(is_check({"native_window_drag": {"dx": 0, "dy": 0}}))

    def test_stationary_window_and_resize_cannot_count_as_drag_success(self):
        before = {"x": 120, "y": 120, "width": 1000, "height": 680}
        for after in (before, {**before, "x": 144, "y": 144, "width": 1024}):
            with self.subTest(after=after), self.assertRaises(StepError):
                validate_movement(before, after, 24, 24)
        validate_movement(before, {**before, "x": 144, "y": 144}, 24, 24)

    def test_physical_drag_records_displacement_and_releases_on_failure(self):
        for moved in (True, False):
            with self.subTest(moved=moved), TemporaryDirectory() as tmp:
                original = {"x": 10, "y": 10, "width": 1200, "height": 800}
                before = {"x": 120, "y": 120, "width": 1000, "height": 680}
                after = {**before, "x": 144, "y": 144} if moved else before
                ctx = SimpleNamespace(case_dir=Path(tmp), session=Mock())
                ctx.session.execute.return_value = {
                    "x": 6, "y": 0, "width": 12, "height": 680,
                    "viewportWidth": 1000, "viewportHeight": 680,
                }
                with patch("qa_ui_auto.window_drag.window_geometry", side_effect=[original, before, after]), \
                     patch("qa_ui_auto.window_drag.command") as command, \
                     patch("qa_ui_auto.window_drag.time.sleep"):
                    args = {"selector": "#grip", "dx": 24, "dy": 24, "y_fraction": 0.8}
                    if moved:
                        run_window_drag(ctx, args, "0x42", "qa-app")
                    else:
                        with self.assertRaises(StepError):
                            run_window_drag(ctx, args, "0x42", "qa-app")
                    command.assert_any_call("xdotool", "mousedown", "1")
                    command.assert_any_call("xdotool", "mouseup", "1")
                    command.assert_any_call("wmctrl", "-ir", "0x42", "-e", "0,10,10,1200,800")
                receipt = json.loads((Path(tmp) / "native-window-drags.jsonl").read_text())
                self.assertEqual(receipt["passed"], moved)
                self.assertEqual(receipt["after"], after)
                self.assertEqual(receipt["pointer"], {"x": 132, "y": 664})

    def test_rejects_nonfinite_origin_and_zero_displacement(self):
        ctx = SimpleNamespace()
        for args in ({"y_fraction": float("nan"), "dx": 1, "dy": 1}, {"dx": 0, "dy": 0}):
            with self.subTest(args=args), self.assertRaises(StepError):
                run_window_drag(ctx, args, "0x42", "qa-app")
