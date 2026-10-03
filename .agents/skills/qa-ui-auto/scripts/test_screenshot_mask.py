import base64
import io
import json
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock

from PIL import Image

from qa_ui_auto.steps import StepContext, StepError
from qa_ui_auto.steps.screenshot_mask import compare_mask, step_assert_screenshot_mask, step_screenshot_reference


class ScreenshotMaskTest(TestCase):
    def setUp(self):
        self.source = Image.new("RGBA", (144, 192))
        self.source.putdata([(x * 7 % 256, y * 11 % 256, (x + y) % 256, 255)
                             for y in range(192) for x in range(144)])
        self.crop = {"x": 0, "y": 0, "width": 144, "height": 192}
        self.polygon = [{"x": x, "y": y} for x, y in
                        [(0, 0), (144, 0), (144, 60), (60, 60), (60, 192), (0, 192)]]
        _, self.expected, _ = compare_mask(self.source, self.source, self.crop, self.polygon)

    def test_matching_rgba_passes_and_unmasked_or_blank_images_fail(self):
        self.assertTrue(compare_mask(self.expected, self.source, self.crop, self.polygon)[0]["passed"])
        self.assertFalse(compare_mask(self.source, self.source, self.crop, self.polygon)[0]["passed"])
        blank = Image.new("RGBA", self.source.size)
        self.assertFalse(compare_mask(blank, self.source, self.crop, self.polygon)[0]["passed"])
        self.assertFalse(compare_mask(self.expected.resize((72, 96)), self.source, self.crop, self.polygon)[0]["passed"])

    def test_exact_alpha_outside_and_inside_is_required(self):
        for position, rgba in [((120, 150), (0, 0, 0, 1)), ((20, 150), (140, 114, 170, 254))]:
            corrupt = self.expected.copy()
            corrupt.putpixel(position, rgba)
            metrics = compare_mask(corrupt, self.source, self.crop, self.polygon)[0]
            self.assertEqual(metrics["alphaMismatches"], 1)
            self.assertFalse(metrics["passed"])

    def test_black_interior_and_missing_tile_fail_rgb_oracle(self):
        corrupt = self.expected.copy()
        for y in range(24, 48):
            for x in range(24, 48):
                corrupt.putpixel((x, y), (0, 0, 0, 255))
        metrics = compare_mask(corrupt, self.source, self.crop, self.polygon)[0]
        self.assertGreater(metrics["worstTileRgbError"], 5)
        self.assertFalse(metrics["passed"])

    def test_two_pixel_boundary_does_not_excuse_other_pixels(self):
        corrupt = self.expected.copy()
        corrupt.putpixel((61, 100), (100, 50, 200, 130))
        self.assertTrue(compare_mask(corrupt, self.source, self.crop, self.polygon)[0]["passed"])
        corrupt.putpixel((64, 100), (100, 50, 200, 130))
        self.assertFalse(compare_mask(corrupt, self.source, self.crop, self.polygon)[0]["passed"])

    def test_reference_retains_original_and_failure_retains_actual_metrics(self):
        def info(image):
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            return {"loaded": True, "width": image.width, "height": image.height,
                    "src": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()}
        with tempfile.TemporaryDirectory() as tmp:
            page = Mock()
            page.locator.return_value.count.return_value = 1
            page.locator.return_value.evaluate.return_value = info(self.source)
            ctx = StepContext(page, "TC-MASK", Path(tmp), {}, {})
            step_screenshot_reference(ctx, {"selector": "img"})
            original = Path(tmp) / "screenshot-mask-original.png"
            self.assertTrue(original.is_file())
            page.locator.return_value.evaluate.return_value = info(self.expected)
            args = {"selector": "img", "crop": self.crop, "polygon": self.polygon}
            ctx.step_index = 2
            step_assert_screenshot_mask(ctx, args)
            good = json.loads((Path(tmp) / "screenshot-mask-2-metrics.json").read_text())
            self.assertTrue(good["passed"])
            page.locator.return_value.evaluate.return_value = info(self.source)
            ctx.step_index = 3
            with self.assertRaisesRegex(StepError, "RGB/alpha"):
                step_assert_screenshot_mask(ctx, args)
            for name in ("actual.png", "expected.png", "difference.png", "metrics.json"):
                self.assertTrue((Path(tmp) / f"screenshot-mask-3-{name}").is_file())
            bad = json.loads((Path(tmp) / "screenshot-mask-3-metrics.json").read_text())
            self.assertFalse(bad["passed"])
            self.assertGreater(bad["alphaMismatches"], 100)
            page.evaluate.assert_not_called()

    def test_invalid_contract_and_missing_reference_fail_without_page_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = Mock()
            ctx = StepContext(page, "TC-MASK", Path(tmp), {}, {})
            args = {"selector": "img", "crop": self.crop, "polygon": self.polygon}
            with self.assertRaisesRegex(StepError, "screenshot_reference"):
                step_assert_screenshot_mask(ctx, args)
            with self.assertRaises(StepError):
                step_assert_screenshot_mask(ctx, {**args, "crop": {**self.crop, "width": True}})
            with self.assertRaises(StepError):
                step_assert_screenshot_mask(ctx, {**args, "polygon": [{"x": float("nan"), "y": 0}] * 3})
            ctx.dry_run = True
            step_assert_screenshot_mask(ctx, args)
            page.evaluate.assert_not_called()
            page.locator.assert_not_called()
