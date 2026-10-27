"""Keep the mandatory crash suite executable and make real case failures fail CI."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

from qa_ui_auto.ci import make_plan
from qa_ui_auto.testcase import discover

ROOT = Path(__file__).resolve().parents[4]
EXPECTED = {"TC-WS-038", "TC-WS-039", "TC-WS-045", "TC-WS-051", "TC-WS-052", "TC-WS-053", "TC-WS-054", "TC-WS-055", "TC-WS-056"}


class CrashRegressionTests(unittest.TestCase):
    def test_tag_and_smoke_keep_every_reported_crash_and_boundary_case(self):
        cases = [c for c in discover(ROOT / "qa-ui-auto-tests/cases") if "crash-regression" in c.tags]
        self.assertEqual({c.id for c in cases}, EXPECTED)
        policy = yaml.safe_load((ROOT / "qa-ui-auto-tests/ci/policy.yaml").read_text())
        self.assertTrue(EXPECTED.issubset(policy["smoke"]))
        for case in cases:
            with self.subTest(case=case.id):
                self.assertIn("browser" if case.id == "TC-WS-055" else "native", case.modes)
                self.assertTrue(any("assert_no_runtime_errors" in step for step in case.steps))
                self.assertIsNone(case.skip)

    def test_full_tag_plans_all_three_packaged_release_webviews_and_browser_cases(self):
        args = argparse.Namespace(scope="selected", head="", base="", platforms="linux,windows,macos",
                                  modes="browser,native", case_ids="", features="", tags="crash-regression",
                                  shards="1", browser_workers=2)
        plan = make_plan(args)
        self.assertFalse(plan["gaps"])
        self.assertEqual(len(plan["entries"]), 6)
        for entry in plan["entries"]:
            expected = EXPECTED - ({"TC-WS-055"} if entry["mode"] == "native" else {"TC-WS-051", "TC-WS-054", "TC-WS-056"})
            self.assertEqual(set(entry["selected_ids"]), expected)
            self.assertEqual("release" in entry["capabilities"], entry["mode"] == "native")

    def test_pr_and_focused_workflow_entries_keep_crash_suite(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/qa-ui-auto-platforms.yml").read_text())
        plan = workflow["jobs"]["plan"]
        self.assertNotIn("if", plan, "PR planning must not be skipped")
        env = next(s["env"] for s in plan["steps"] if s.get("name") == "Plan exact cases and dependencies")
        self.assertIn("github.event_name == 'pull_request' && 'selected'", env["QA_SCOPE"])
        self.assertIn("github.event_name == 'pull_request' && 'crash-regression'", env["QA_TAGS"])
        self.assertIn("inputs.scope == 'selected' || inputs.scope == 'impacted'", env["QA_TAGS"])
        self.assertIn("format('{0},crash-regression', inputs.tags)", env["QA_TAGS"])
        triggers = workflow.get("on", workflow.get(True))
        paths = triggers["pull_request"]["paths"]
        for path in ["src/**", "src-tauri/src/**", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches/**", "src-tauri/Cargo.lock"]:
            self.assertIn(path, paths)

    def test_failed_or_missing_case_summary_fails_all_scopes(self):
        jobs = yaml.safe_load((ROOT / ".github/workflows/qa-ui-auto-platforms.yml").read_text())["jobs"]
        gate = next(s for s in jobs["summarize"]["steps"] if s.get("name") == "Require all planned cases to pass")
        self.assertEqual(gate["if"], "needs.plan.result == 'success'")
        for passed in (True, False, None):
            with self.subTest(passed=passed), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp) / "qa-ui-auto-report"
                directory.mkdir()
                if passed is not None:
                    (directory / "ci-summary.json").write_text(json.dumps({"passed": passed}))
                # Execute the exact workflow gate: no substitute predicate.
                command = gate["run"].replace("python -c", '"' + sys.executable + '" -c', 1)
                result = subprocess.run(command, shell=True, cwd=tmp, capture_output=True,
                                        env={**os.environ, "PYTHONUTF8": "1"})
                self.assertEqual(result.returncode == 0, passed is True, result.stderr)


if __name__ == "__main__":
    unittest.main()
