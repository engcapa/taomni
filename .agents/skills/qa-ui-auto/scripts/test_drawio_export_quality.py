"""Independent artifact checks reject the regressions reported in Mermaid export."""
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from qa_ui_auto.drawio_export_quality import inspect_drawio
from qa_ui_auto.steps import StepError


def sample():
    file = ET.Element("mxfile")
    root = ET.SubElement(ET.SubElement(ET.SubElement(file, "diagram"), "mxGraphModel"), "root")
    ET.SubElement(root, "mxCell", id="0")
    ET.SubElement(root, "mxCell", id="1", parent="0")
    source = ET.SubElement(root, "object", id="mermaid-node-0", mermaidSource="flowchart LR\nA --> B")
    for parent, identity in ((source, None), (root, "mermaid-node-1")):
        cell = ET.SubElement(parent, "mxCell", parent="1", vertex="1", style="rounded=0;", **({"id": identity} if identity else {}))
        ET.SubElement(cell, "mxGeometry", x="10", y="20", width="80", height="40", **{"as": "geometry"})
    edge = ET.SubElement(root, "mxCell", id="mermaid-edge-0", parent="1", edge="1", source="mermaid-node-0", target="mermaid-node-1", style="edgeStyle=none;curved=1;")
    geometry = ET.SubElement(edge, "mxGeometry", relative="1", **{"as": "geometry"})
    ET.SubElement(geometry, "mxPoint", x="90", y="40", **{"as": "sourcePoint"})
    ET.SubElement(geometry, "mxPoint", x="200", y="40", **{"as": "targetPoint"})
    points = ET.SubElement(geometry, "Array", **{"as": "points"})
    ET.SubElement(points, "mxPoint", x="150", y="70")
    return file


class DrawioExportQualityTests(unittest.TestCase):
    def check(self, file):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "diagram.drawio"
            path.write_bytes(ET.tostring(file))
            return inspect_drawio(path)

    def test_independent_native_cells_and_curve_pass(self):
        result = self.check(sample())
        self.assertEqual(result["independentCells"], 3)
        self.assertEqual(result["curvedEdges"], 1)
        self.assertEqual(result["maximumCurveControlPoints"], 1)

    def test_dense_svg_samples_cannot_be_exported_as_editable_curve_handles(self):
        file = sample()
        points = file.find(".//mxCell[@edge='1']/mxGeometry/Array")
        for index in range(20):
            ET.SubElement(points, "mxPoint", x=str(index * 10), y="50")
        with self.assertRaisesRegex(StepError, "compact native draw.io connector"):
            self.check(file)

    def test_group_and_image_fallbacks_fail(self):
        for style, parent in (("group;", "1"), ("shape=image;", "1"), ("rounded=0;", "diagram-group")):
            with self.subTest(style=style, parent=parent):
                file = sample()
                node = file.find(".//object/mxCell")
                node.set("style", style)
                node.set("parent", parent)
                with self.assertRaisesRegex(StepError, "grouped, flattened"):
                    self.check(file)

    def test_missing_terminals_and_waypoint_endpoints_fail(self):
        file = sample()
        file.find(".//mxCell[@edge='1']").set("target", "lost-node")
        with self.assertRaisesRegex(StepError, "missing terminal"):
            self.check(file)
        file = sample()
        geometry = file.find(".//mxCell[@edge='1']/mxGeometry")
        geometry.remove(geometry.find("mxPoint[@as='sourcePoint']"))
        with self.assertRaisesRegex(StepError, "endpoints"):
            self.check(file)

    def test_linear_source_cannot_silently_become_curved(self):
        file = sample()
        file.find(".//object").set("mermaidSource", "---\nconfig:\n  flowchart:\n    curve: linear\n---\nflowchart TD\nA --> B")
        with self.assertRaisesRegex(StepError, "became curves"):
            self.check(file)

    def test_whole_sequence_cannot_silently_fall_back_to_an_image_or_lose_messages(self):
        file = sample()
        file.find(".//object").set("mermaidSource", "sequenceDiagram\nA->>B: task")
        with self.assertRaisesRegex(StepError, "lost messages"):
            self.check(file)


if __name__ == "__main__":
    unittest.main()
