"""A cheap build preflight must retain all binary reuse checks."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import native_build


class BuildCheckTest(unittest.TestCase):
    def test_check_never_builds_and_reports_changed_inputs_without_values(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "taomni.exe"
            binary.write_bytes(b"isolated fake binary, never executed")
            inputs = {"source_sha256": "source", "environment": {"NODE_ENV": "production"}}
            record = {"identifier": native_build.QA_APP_ID, "binary_sha256": native_build.binary_digest(binary),
                      "build_inputs": inputs, "build_duration_sec": 123}
            record_path = native_build.identity_path(binary)
            record_path.write_text(json.dumps(record), encoding="utf-8")
            original = record_path.read_bytes()
            with patch.object(native_build, "qa_binary", return_value=binary), \
                 patch.object(native_build, "build_inputs", return_value=inputs), \
                 patch.object(native_build.subprocess, "run") as compile_process, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(native_build.main(["--check"]), 0)
                inputs = dict(inputs, environment={"NODE_ENV": "development"})
                result = native_build.check_build(inputs=inputs)
                self.assertFalse(result["reusable"])
                self.assertEqual(result["changed_inputs"], ["environment"])
                self.assertEqual(result["recorded_build_duration_sec"], 123)
                compile_process.assert_not_called()
            self.assertEqual(record_path.read_bytes(), original)

    def test_missing_or_replaced_binary_cannot_be_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "taomni"
            with patch.object(native_build, "qa_binary", return_value=binary), \
                 patch.object(native_build, "build_inputs") as inputs, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(native_build.main(["--check"]), 1)
                binary.write_bytes(b"changed binary")
                native_build.identity_path(binary).write_text(json.dumps({
                    "identifier": native_build.QA_APP_ID, "binary_sha256": "wrong"}))
                self.assertEqual(native_build.main(["--check"]), 1)
                inputs.assert_not_called()

    def test_missing_input_is_not_equivalent_to_recorded_null(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "taomni"
            binary.write_bytes(b"fake binary, never executed")
            native_build.identity_path(binary).write_text(json.dumps({
                "identifier": native_build.QA_APP_ID,
                "binary_sha256": native_build.binary_digest(binary),
                "build_inputs": {"source_sha256": "source", "optional": None},
            }), encoding="utf-8")
            with patch.object(native_build, "qa_binary", return_value=binary):
                result = native_build.check_build(inputs={"source_sha256": "source"})
            self.assertFalse(result["reusable"])
            self.assertEqual(result["changed_inputs"], ["optional"])


if __name__ == "__main__":
    unittest.main()
