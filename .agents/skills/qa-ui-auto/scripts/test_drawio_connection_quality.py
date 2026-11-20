import unittest
import xml.etree.ElementTree as ET
from qa_ui_auto.drawio_connection_quality import inspect_sequence_connections
from qa_ui_auto.steps import StepError


def sample(anchor_direction="0", rotation="0", flip_h="0", exit_x="7", exit_y="0.159"):
    actor = ET.fromstring(f'<mxCell id="actor" vertex="1" style="shape=line;direction=south;anchorPointDirection={anchor_direction};rotation={rotation};flipH={flip_h};"><mxGeometry x="300" y="80" width="1" height="630"/></mxCell>')
    edge = ET.fromstring(f'<mxCell id="message" edge="1" taomniKind="sequence-message" source="actor" target="actor" style="exitX={exit_x};exitY={exit_y};exitPerimeter=0;entryX={exit_x};entryY={exit_y};entryPerimeter=0;"><mxGeometry><mxPoint as="sourcePoint" x="307" y="180"/><mxPoint as="targetPoint" x="307" y="180"/></mxGeometry></mxCell>')
    return {"actor": actor, "message": edge}


class DrawioConnectionQualityTests(unittest.TestCase):
    def test_retained_endpoint_is_close_after_serialization_rounding(self):
        result = inspect_sequence_connections(sample())
        self.assertEqual(result["checkedSequenceEndpoints"], 2)
        self.assertAlmostEqual(result["maximumEndpointError"], 0.17)

    def test_drawio_default_direction_displaces_a_vertical_lifeline_anchor(self):
        for value in ("1", None):
            cells = sample()
            style = cells["actor"].get("style").replace("anchorPointDirection=0;", "" if value is None else "anchorPointDirection=1;")
            cells["actor"].set("style", style)
            with self.assertRaisesRegex(StepError, "routed sequence endpoint away"):
                inspect_sequence_connections(cells)

    def test_legacy_flip_axis_requires_compensated_anchor(self):
        cells = sample(rotation="90", flip_h="1", exit_x="-6", exit_y="0.841")
        for point in cells["message"].find("mxGeometry"):
            point.set("x", "515.5"); point.set("y", "388.5")
        result = inspect_sequence_connections(cells)
        self.assertLess(result["maximumEndpointError"], 0.2)
        cells["message"].set("style", cells["message"].get("style").replace("exitY=0.841", "exitY=0.159"))
        with self.assertRaisesRegex(StepError, "routed sequence endpoint away"):
            inspect_sequence_connections(cells)

    def test_missing_connection_cannot_pass_as_free_edge(self):
        cells = sample(); cells["message"].set("source", "missing")
        with self.assertRaisesRegex(StepError, "lost its connected endpoint"):
            inspect_sequence_connections(cells)


if __name__ == "__main__":
    unittest.main()
