"""The export oracle must work with the actual native verb context."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from qa_ui_auto.export_quality import native
from qa_ui_auto.native_steps import NativeStepContext
from qa_ui_auto.steps import StepError


class NativeExportQualityTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
