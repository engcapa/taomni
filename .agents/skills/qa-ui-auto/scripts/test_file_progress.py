import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from qa_ui_auto.file_progress import assert_file_progress
from qa_ui_auto.steps import StepError


class FileProgressTest(TestCase):
    def test_observations_use_host_bytes_and_preserve_failures(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory))
            target = ctx.case_dir / "job.bin"
            target.write_bytes(b"first")
            args = {"path": str(target), "full_size": 100, "sample_sec": .2}
            with patch("qa_ui_auto.file_progress.time.sleep", side_effect=lambda _: target.write_bytes(b"next bytes")):
                assert_file_progress(ctx, {**args, "state": "growing"})
            assert_file_progress(ctx, {**args, "state": "stable"})
            assert_file_progress(ctx, {**args, "state": "incomplete"})
            target.write_bytes(b"x" * 100)
            with self.assertRaises(StepError):
                assert_file_progress(ctx, {**args, "state": "incomplete"})
            rows = [json.loads(line) for line in (ctx.case_dir / "host-file-progress.jsonl").read_text().splitlines()]
            self.assertEqual([row["passed"] for row in rows], [True, True, True, False])
            self.assertEqual(rows[0]["samples"][-1]["bytes"], len(b"next bytes"))

    def test_rejects_paths_outside_qa_report(self):
        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(StepError, "case report"):
                assert_file_progress(SimpleNamespace(case_dir=Path(directory)), {"path": str(Path(directory).parent / "other.bin"), "state": "incomplete", "full_size": 100})
