"""The export oracle must work with the actual native verb context."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from qa_ui_auto.export_quality import inspect_png_document, inspect_quality, native, raster_grid_pixels
from qa_ui_auto.native_steps import NativeStepContext
from qa_ui_auto.steps import StepError


class NativeExportQualityTest(unittest.TestCase):
    def test_blank_or_monochrome_diagrams_cannot_stand_in_for_original_image(self):
        from PIL import Image, ImageDraw
        page = Image.new("RGB", (1600, 2200), "white")
        draw = ImageDraw.Draw(page)
        draw.rectangle((80, 80, 1400, 600), outline="black", width=12)
        self.assertEqual(raster_grid_pixels(page), {"red": 0, "blue": 0})
        draw.rectangle((100, 800, 800, 820), fill="red")
        draw.rectangle((100, 900, 800, 920), fill="blue")
        counts = raster_grid_pixels(page)
        self.assertGreater(counts["red"], 250)
        self.assertGreater(counts["blue"], 250)

    def test_document_png_must_rasterize_at_the_300_dpi_standard(self):
        from PIL import Image, ImageDraw
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "quality.png"
            image = Image.new("RGB", (2500, 9000), "white")
            draw = ImageDraw.Draw(image)
            draw.rectangle((100, 100, 2400, 8000), outline="black", width=12)
            image.save(target, format="PNG")
            result = inspect_png_document(target)
            self.assertEqual(result["width"], 2500)
            self.assertAlmostEqual(result["scale"], 3.125, places=3)

    def test_document_png_below_high_density_or_over_canvas_limits_is_rejected(self):
        from PIL import Image, ImageDraw
        with tempfile.TemporaryDirectory() as directory:
            low = Path(directory) / "low.png"
            image = Image.new("RGB", (800, 3000), "white")
            draw = ImageDraw.Draw(image)
            draw.rectangle((50, 50, 750, 2950), outline="black", width=12)
            image.save(low, format="PNG")
            with self.assertRaisesRegex(StepError, "300 DPI standard"):
                inspect_png_document(low)
            huge = Path(directory) / "huge.png"
            image = Image.new("L", (2500, 17000), "white")
            image.save(huge, format="PNG")
            with self.assertRaisesRegex(StepError, "canvas limits"):
                inspect_png_document(huge)
            blank = Path(directory) / "blank.png"
            Image.new("RGB", (2500, 4000), "white").save(blank, format="PNG")
            with self.assertRaisesRegex(StepError, "blank"):
                inspect_png_document(blank)

    def test_inspects_and_records_from_actual_native_context(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory) / "TC-EXPORT"
            case.mkdir()
            ctx = NativeStepContext(object(), case, {})
            target = Path(directory) / "exports" / "quality.pdf"
            result = {"pageCount": 4, "pages": [{"dpi": 300}]}
            with patch("qa_ui_auto.export_quality.inspect_quality", return_value=result) as inspect:
                self.assertIn("matched: pdf", native(ctx, {"path": str(target), "kind": "pdf"}))
            inspect.assert_called_once_with(target.resolve(), "pdf")
            self.assertEqual(json.loads((case / "pdf-quality.json").read_text()), result)

    def test_rejects_reading_an_export_outside_the_retained_run(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory) / "run" / "TC-EXPORT"
            case.mkdir(parents=True)
            ctx = NativeStepContext(object(), case, {})
            with patch("qa_ui_auto.export_quality.inspect_quality") as inspect:
                with self.assertRaisesRegex(StepError, "outside the retained run"):
                    native(ctx, {"path": str(Path(directory) / "outside.pdf"), "kind": "pdf"})
                inspect.assert_not_called()

    def test_dry_run_does_not_read_host_files(self):
        with patch("qa_ui_auto.export_quality.inspect_quality") as inspect:
            self.assertIn("dry-run", native(SimpleNamespace(dry_run=True), {"path": "/missing.pdf", "kind": "pdf"}))
            inspect.assert_not_called()


class VisioReviewPdfTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "review.pdf"

    def draw_review(self, *, approval_color="#dfeddb", delivery_x=234, label="Release confirmed",
                    page_size=(576, 288), blank=False, extra_page=False, flatten=False):
        import pymupdf
        from PIL import ImageColor

        def color(value):
            return tuple(channel / 255 for channel in ImageColor.getrgb(value))

        with pymupdf.open() as doc:
            page = doc.new_page(width=page_size[0], height=page_size[1])
            if not blank:
                for left, fill, text in ((72, approval_color, "Routing approval"),
                                         (delivery_x, "#f2efd7", label)):
                    page.draw_rect((left, 115.2, left + 144, 172.8), color=color("#1e3a5f"),
                                   fill=color(fill), width=1.44)
                    page.insert_text((left, 144), text, fontsize=13)
                # Glyph antialiasing can also yield a few pixels of the
                # green node's color within the neighboring yellow node.
                page.draw_rect((340, 140, 342, 142), color=None, fill=color(approval_color))
            if extra_page:
                doc.new_page()
            if flatten:
                with pymupdf.open() as bitmap_pdf:
                    target = bitmap_pdf.new_page(width=page_size[0], height=page_size[1])
                    target.insert_image(target.rect, pixmap=page.get_pixmap(dpi=144))
                    bitmap_pdf.save(self.path)
            else:
                doc.save(self.path)

    def test_vector_and_flattened_review_have_visible_moved_label(self):
        for flatten in (False, True):
            with self.subTest(flatten=flatten):
                self.draw_review(flatten=flatten)
                result = inspect_quality(self.path, "visio-review-pdf")
                self.assertEqual(result["pageSizePt"], [576, 288])
                self.assertGreater(result["deliveryLabelWidthPt"], 75)

    def test_wrong_page_blank_sheet_and_stale_drafts_fail(self):
        for change, error in (({"approval_color": "#dae8fb"}, "approval node"),
                              ({"blank": True}, "approval node"),
                              ({"delivery_x": 360}, "delivery node"),
                              ({"label": "Delivery"}, "edited delivery label"),
                              ({"label": ""}, "edited delivery label")):
            with self.subTest(change=change), self.assertRaisesRegex(StepError, error):
                self.draw_review(**change)
                inspect_quality(self.path, "visio-review-pdf")

    def test_physical_page_size_and_count(self):
        for change, error in (({"page_size": (768, 384)}, "8 by 4 inch"),
                              ({"extra_page": True}, "single-page")):
            with self.subTest(change=change), self.assertRaisesRegex(StepError, error):
                self.draw_review(**change)
                inspect_quality(self.path, "visio-review-pdf")


if __name__ == "__main__":
    unittest.main()
