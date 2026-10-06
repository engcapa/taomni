import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from stage_screenshot_artifacts import stage, stage_macos_crashes


class StageScreenshotArtifactsTest(unittest.TestCase):
    def test_single_report_root_keeps_outputs_and_receipts_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "runner-temp" / "taomni-qa-artifacts"
            source.mkdir(parents=True)
            (source / "windows-recording.mp4").write_bytes(b"actual-output")
            report = root / "windows-native"
            run = report / "run-1"
            run.mkdir(parents=True)
            receipt = run / "runner-receipt.json"
            receipt.write_bytes(b'{"signed":"original"}')
            before = receipt.read_bytes()
            result = stage(source, report)
            output = report / "screenshot-outputs" / "windows-recording.mp4"
            self.assertEqual(output.read_bytes(), b"actual-output")
            self.assertEqual(result["files"][0]["sha256"], hashlib.sha256(b"actual-output").hexdigest())
            self.assertEqual(receipt.read_bytes(), before)
            self.assertEqual(json.loads((report / "screenshot-output-manifest.json").read_text()), result)
            self.assertFalse((run / "screenshot-outputs").exists())

    def test_missing_outputs_are_explicit_not_success_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = stage(root / "missing", root / "report")
            self.assertFalse(result["source_exists"])
            self.assertEqual(result["files"], [])
            self.assertNotIn("passed", result)

    def test_only_recent_app_crashes_are_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            crashes = root / "diagnostics"
            crashes.mkdir()
            for name in ["Taomni QA-recent.ips", "taomni-old.crash", "Other.ips", "taomni.txt"]:
                (crashes / name).write_bytes(b"diagnostic")
            os.utime(crashes / "taomni-old.crash", (1, 1))
            try:
                (crashes / "taomni-symlink.ips").symlink_to(crashes / "Other.ips")
            except OSError as error:
                if os.name == "nt" and error.winerror == 1314:
                    self.skipTest("The macOS crash symlink fixture requires symlink creation permission")
                raise
            report = root / "report"
            result = stage_macos_crashes([crashes, root / "missing"], report, since=2)
            self.assertEqual([item["path"] for item in result["files"]], ["Taomni QA-recent.ips"])
            self.assertEqual((report / "native-crash-reports/Taomni QA-recent.ips").read_bytes(), b"diagnostic")
            self.assertNotIn("passed", result)
