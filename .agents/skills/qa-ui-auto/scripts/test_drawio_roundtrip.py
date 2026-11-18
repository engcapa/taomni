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
