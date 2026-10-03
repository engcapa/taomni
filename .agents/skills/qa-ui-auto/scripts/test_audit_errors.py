"""Invalid authoring inputs should give actionable diagnostics, not tracebacks."""
import contextlib
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from qa_ui_auto import audit


class AuditInputErrorsTest(TestCase):
    def test_gate_retains_schema_and_yaml_errors_without_evaluating_coverage(self):
        for content in (
            "id: TC-bad\ntitle: bad\nfixtures: [unknown_fixture]\ntimeout_sec: 10\nsteps: []\n",
            "id: [malformed\n",
        ):
            with self.subTest(content=content), TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "TC-bad.testcase.yaml").write_text(content, encoding="utf-8")
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    code = audit.main(["--cases", str(root), "--gate", "--json"])
                self.assertEqual(code, 1)
                report = json.loads(output.getvalue())
                self.assertTrue(report["health"]["lint_cases"]["errors"])
                self.assertIn("coverage_skipped", report["health"])
                self.assertIsNone(report["gate"])
                self.assertEqual(report["gaps"], [])
