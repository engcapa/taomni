"""Raster fixture/input/oracle contracts; never launches a browser or native UI."""
from __future__ import annotations

import base64
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PIL import Image
from qa_ui_auto import viewer_raster
from qa_ui_auto.fixtures import raster_files
from qa_ui_auto.steps import StepError


class RasterContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        report = Path(temporary.name)
        self.ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, values={}, report_root=report,
                                   case_dir=report / "case", case_id="raster", worker_id=0)
        raster_files.setup(self.ctx)

    def test_actual_formats_decode_and_boundary_files_have_exact_independent_sizes(self):
        root = Path(self.ctx.values["raster_root"])
        for name in ["01-landscape.png", "02-photo.jpg", "03-lossless.webp", "04-palette.gif"]:
            with Image.open(root / name) as image:
                self.assertEqual(image.size, (640, 360))
                image.load()
        self.assertEqual((root / "91-preview-limit.png").stat().st_size, 20 * 1024 * 1024 + 1)
        self.assertEqual((root / "92-viewer-limit.png").stat().st_size, 32 * 1024 * 1024 + 1)
        with self.assertRaises(Exception):
            Image.open(root / "90-corrupt.png").load()
        receipt = json.loads((self.ctx.case_dir / "file-open-fixture.json").read_text())
        self.assertEqual(receipt["mode"], "native")
        self.assertEqual(receipt["root"], str(root))

    def test_bad_inputs_cannot_supply_arbitrary_paths_selectors_or_synthetic_event_data(self):
        for args in [{"action": "wheel", "deltaY": 0}, {"action": "wheel", "deltaY": True},
                     {"action": "wheel", "deltaY": 1201}, {"action": "wheel", "deltaY": 1.5},
                     {"action": "wheel", "deltaY": 120, "selector": "body"},
                     {"action": "clipboard", "kind": "image", "path": "/secret"}]:
            with self.assertRaises(StepError):
                viewer_raster.validate(args)

    def test_browser_wheel_is_actual_mouse_input_not_dom_event_dispatch(self):
        manifest = self.ctx.case_dir / "file-open-fixture.json"
        data = json.loads(manifest.read_text()); data["mode"] = "browser"; manifest.write_text(json.dumps(data))
        self.ctx.page = Mock()
        viewer_raster.browser(self.ctx, {"action": "wheel", "deltaY": -120})
        self.ctx.page.mouse.wheel.assert_called_once_with(0, -120)
        self.ctx.page.evaluate.assert_not_called()

    def test_native_wheel_uses_w3c_wheel_source_and_hit_tested_geometry(self):
        self.ctx.session = Mock()
        self.ctx.session.find.return_value = "canvas"
        self.ctx.session.endpoint.return_value = "/session/id/actions"
        with patch("native_pointer.prepare_pointer_target", return_value={"x": 300, "y": 200}):
            viewer_raster.native(self.ctx, {"action": "wheel", "deltaY": -120})
        body = self.ctx.session.request.call_args.args[2]
        self.assertEqual(body["actions"][0]["type"], "wheel")
        self.assertEqual(body["actions"][0]["actions"][0]["deltaY"], -120)
        self.ctx.session.execute.assert_not_called()

    def test_native_clipboard_is_independent_and_bad_pixels_fail_with_retained_observation(self):
        oracle = self.ctx.case_dir / "raster-original.png"
        def original(target):
            Path(target).write_bytes(oracle.read_bytes())
        with patch("qa_ui_auto.host_clipboard.save_image", side_effect=original):
            viewer_raster.native(self.ctx, {"action": "clipboard", "kind": "image"})
        def wrong(target):
            Image.new("RGB", (640, 360), "black").save(target)
        with patch("qa_ui_auto.host_clipboard.save_image", side_effect=wrong):
            with self.assertRaisesRegex(StepError, "pixels differ"):
                viewer_raster.native(self.ctx, {"action": "clipboard", "kind": "image"})
        observations = [json.loads(line) for line in (self.ctx.case_dir / "raster-observations.jsonl").read_text().splitlines()]
        self.assertEqual([row["passed"] for row in observations], [True, False])

    def test_browser_clipboard_reads_actual_item_bytes_and_compares_decoded_pixels(self):
        manifest = self.ctx.case_dir / "file-open-fixture.json"
        data = json.loads(manifest.read_text()); data["mode"] = "browser"; manifest.write_text(json.dumps(data))
        self.ctx.page = Mock()
        self.ctx.page.evaluate.return_value = base64.b64encode((self.ctx.case_dir / "raster-original.png").read_bytes()).decode()
        viewer_raster.browser(self.ctx, {"action": "clipboard", "kind": "image"})
        script = self.ctx.page.evaluate.call_args.args[0]
        self.assertIn("navigator.clipboard.read()", script)
        self.assertNotIn("clipboard.write", script)
        self.assertNotIn("invoke", script)


if __name__ == "__main__":
    unittest.main()
