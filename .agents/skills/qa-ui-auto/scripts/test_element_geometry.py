import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock

from qa_ui_auto.element_geometry import assert_geometry, run_geometry
from qa_ui_auto.steps import StepError, get
from qa_ui_auto.native_steps import VERBS


class ElementGeometryTest(TestCase):
    def setUp(self):
        self.args = {"selector": "button[data-tool-window-id]", "min_width": 32, "min_height": 32,
                     "min_count": 3, "same_width": True, "icon_size": 16}
        self.samples = [{"id": name, "width": 34, "height": 32, "icon": {"width": 16, "height": 16}}
                        for name in ("sessions", "tools", "project")]

    def test_checks_every_button_and_icon(self):
        assert_geometry(self.args, self.samples)
        self.samples[-1]["width"] = 25
        with self.assertRaisesRegex(StepError, "project width"):
            assert_geometry(self.args, self.samples)

    def test_rejects_missing_buttons_and_shrunken_icons(self):
        with self.assertRaisesRegex(StepError, "matched 2"):
            assert_geometry(self.args, self.samples[:2])
        self.samples[-1]["icon"]["height"] = 12
        with self.assertRaisesRegex(StepError, "project icon"):
            assert_geometry(self.args, self.samples)

    def test_equal_width_and_finite_dimensions_are_required(self):
        self.samples[-1]["width"] = 36
        with self.assertRaisesRegex(StepError, "differs"):
            assert_geometry(self.args, self.samples)
        self.samples[-1]["width"] = float("nan")
        with self.assertRaises(StepError):
            assert_geometry(self.args, self.samples)

    def test_rejects_offscreen_and_obscured_controls(self):
        args = dict(self.args, min_count=1, within_viewport=True, hit_center=True)
        item = dict(self.samples[0], left=4, top=4, right=38, bottom=36,
                    viewport_width=400, viewport_height=450, hit_center=True)
        assert_geometry(args, [item])
        with self.assertRaisesRegex(StepError, "outside the viewport"):
            assert_geometry(args, [dict(item, right=410)])
        with self.assertRaisesRegex(StepError, "blocked or inert"):
            assert_geometry(args, [dict(item, hit_center=False)])

    def test_keeps_actual_measurements_when_an_assertion_fails(self):
        self.samples[-1]["height"] = 24
        with TemporaryDirectory() as directory:
            evaluate = Mock(return_value=self.samples)
            with self.assertRaisesRegex(StepError, "project height"):
                run_geometry(self.args, evaluate, Path(directory))
            receipt = json.loads((Path(directory) / "element-geometries.jsonl").read_text())
            self.assertEqual(receipt["measurements"][-1]["height"], 24)
            self.assertIn('document.querySelectorAll("button[data-tool-window-id]")', evaluate.call_args[0][0])

    def test_browser_and_native_dispatch_use_the_same_measurements(self):
        with TemporaryDirectory() as directory:
            ctx = Mock(case_dir=Path(directory), dry_run=False)
            ctx.page.evaluate.return_value = self.samples
            ctx.session.execute.return_value = self.samples
            get("assert_element_geometry")(ctx, self.args)
            VERBS["assert_element_geometry"](ctx, self.args)
            self.assertEqual(ctx.page.evaluate.call_count, 1)
            self.assertEqual(ctx.session.execute.call_count, 1)
            self.assertEqual(len((Path(directory) / "element-geometries.jsonl").read_text().splitlines()), 2)
