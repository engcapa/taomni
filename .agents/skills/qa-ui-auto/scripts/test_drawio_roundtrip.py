from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import xml.etree.ElementTree as ET

from PIL import Image

from qa_ui_auto.drawio_roundtrip import compare_export, compare_images
from qa_ui_auto.fixtures.markdown_drawio_roundtrip import ASSETS
from qa_ui_auto.steps import StepError


class DrawioRoundtripTest(unittest.TestCase):
    def test_preview_detects_missing_arrow_pixels_with_all_shapes_present(self):
        reference = ASSETS / "roundtrip.drawio.png"
        with TemporaryDirectory() as directory, Image.open(reference) as image:
            report = Path(directory) / "comparison"
            compare_images(reference, reference, report, "Equivalent diagram")
            modified = image.convert("RGB")
            modified.paste("white", (68, 87, 85, 219))
            captured = Path(directory) / "missing-arrow.png"
            modified.save(captured)
            with self.assertRaisesRegex(StepError, "arrows retained"):
                compare_images(reference, captured, report, "Missing connector")
            self.assertTrue(report.with_suffix(".png").is_file())

    def test_preview_accepts_partially_covered_connector_pixels(self):
        reference = ASSETS / "roundtrip.drawio.png"
        with TemporaryDirectory() as directory, Image.open(reference) as image:
            report = Path(directory) / "comparison"
            captured = Path(directory) / "antialiased-connectors.png"
            modified = image.convert("RGB")
            for y in range(modified.height):
                for x in range(modified.width):
                    red, green, blue = modified.getpixel((x, y))
                    if red - green >= 25 and blue - red >= 20:
                        blend = tuple(round((channel + 255) / 2) for channel in (red, green, blue))
                        modified.putpixel((x, y), blend)
            modified.save(captured)
            compare_images(reference, captured, report, "Antialiased connectors")

    def test_preview_detects_one_invisible_label(self):
        reference = ASSETS / "roundtrip.drawio.png"
        with TemporaryDirectory() as directory, Image.open(reference) as image:
            report = Path(directory) / "comparison"
            captured = Path(directory) / "invisible-label.png"
            modified = image.convert("RGB")
            modified.paste("#9ac6ff", (26, 42, 132, 67))
            modified.save(captured)
            with self.assertRaisesRegex(StepError, "Load request label retained 0.0%"):
                compare_images(reference, captured, report, "Invisible label")

    def test_preview_detects_a_missing_shape_outline(self):
        reference = ASSETS / "roundtrip.drawio.png"
        with TemporaryDirectory() as directory, Image.open(reference) as image:
            report = Path(directory) / "comparison"
            captured = Path(directory) / "missing-outline.png"
            modified = image.convert("RGB")
            for y in range(14, 89):
                for x in range(11, 140):
                    red, green, blue = modified.getpixel((x, y))
                    if abs(red - 71) <= 22 and abs(green - 102) <= 22 and abs(blue - 140) <= 22:
                        modified.putpixel((x, y), (154, 198, 255))
            modified.save(captured)
            with self.assertRaisesRegex(StepError, "outlines retained"):
                compare_images(reference, captured, report, "Missing outline")

    def test_export_detects_wrong_edge_terminal_and_lost_waypoint(self):
        original = ASSETS / "roundtrip.drawio"
        with TemporaryDirectory() as directory:
            exported = Path(directory) / "exported.drawio"
            graph = ET.parse(original)
            edge = graph.find(".//mxCell[@id='retry']")
            edge.set("target", "check")
            graph.write(exported, encoding="utf-8")
            with self.assertRaisesRegex(StepError, "cell 'retry' changed"):
                compare_export(original, exported)
            edge.set("target", "load")
            geometry = edge.find("mxGeometry")
            geometry.remove(geometry.find("Array"))
            graph.write(exported, encoding="utf-8")
            with self.assertRaisesRegex(StepError, "cell 'retry' changed"):
                compare_export(original, exported)


if __name__ == "__main__":
    unittest.main()
