"""Timing diagnostics preserve failures and never become pass evidence."""
from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from qa_ui_auto.costs import analyze, main


class CostsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def report(self, name, status="passed", mode="native", platform="Windows", **changes):
        path = self.root / name / "summary.json"
        path.parent.mkdir()
        data = {"dry_run": False, "mode": mode, "platform": platform, "duration_sec": 12,
                "cases": [{"id": "TC-a", "status": status, "duration_sec": 10,
                           "timings": {"fixtures_sec": 3, "session_setup_sec": 2},
                           "step_timings": [{"index": 1, "verb": "wait", "duration_sec": 4}]}]}
        data.update(changes)
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def test_deduplicates_paths_but_preserves_failed_and_skipped_attempts(self):
        path = self.report("run-1", "failed")
        self.report("run-2")
        self.report("run-3", "skipped")
        data = analyze([self.root, path])
        row = data["cases"][0]
        self.assertEqual(len(data["runs"]), 3)
        self.assertEqual(row["outcomes"], {"failed": 1, "passed": 1, "skipped": 1})
        self.assertEqual(row["case_time_sum_sec"], 30)
        self.assertEqual(row["phases"]["fixtures_sec"]["sum_sec"], 9)
        self.assertEqual(row["verbs"]["wait"]["sum_sec"], 12)
        self.assertNotIn("passed", data)

    def test_separates_platforms_and_modes(self):
        self.report("win")
        self.report("linux", platform="Linux")
        self.report("browser", mode="browser")
        self.assertEqual(len(analyze([self.root])["cases"]), 3)

    def test_parallel_case_times_are_not_run_wall_time(self):
        self.report("parallel", mode="browser", cases=[
            {"id": "TC-a", "status": "passed", "duration_sec": 10},
            {"id": "TC-b", "status": "failed", "duration_sec": 9}])
        data = analyze([self.root], {"TC-b"})
        self.assertEqual(data["runs"][0]["wall_sec"], 12)
        self.assertEqual(data["runs"][0]["total_cases"], 2)
        self.assertEqual(data["cases"][0]["case_time_sum_sec"], 9)

    def test_missing_timing_is_unknown_not_zero_sample(self):
        self.report("partial", cases=[{"id": "TC-a", "status": "failed"}])
        row = analyze([self.root])["cases"][0]
        self.assertEqual(row["missing_duration"], 1)
        self.assertIsNone(row["case_time_median_sec"])

    def test_dry_run_and_malformed_reports_are_explicit(self):
        self.report("dry", dry_run=True)
        self.report("invalid", cases=[{"id": "TC-a", "status": "passed", "timings": []}])
        data = analyze([self.root])
        self.assertEqual(data["cases"], [])
        self.assertEqual(len(data["ignored"]), 1)
        self.assertEqual(len(data["problems"]), 1)

    def test_absent_reports_or_case_fail_instead_of_reporting_zero_cost(self):
        self.report("real")
        for flags in (["--reports", str(self.root / "missing")],
                      ["--reports", str(self.root), "--case", "TC-missing"]):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(flags), 2)


if __name__ == "__main__":
    unittest.main()
