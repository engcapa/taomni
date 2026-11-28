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
from qa_ui_auto.feature_catalog import load_features
from qa_ui_auto.testcase import discover

ROOT = Path(__file__).resolve().parents[4]
EXPECTED = {
    "TC-IDE-C8-08-code-style-dialog-lifecycle-browser",
    "TC-WS-038", "TC-WS-039", "TC-WS-045", "TC-WS-051", "TC-WS-052",
    "TC-WS-053", "TC-WS-054", "TC-WS-055", "TC-WS-056", "TC-WS-057",
    "TC-MOBILE-012", "TC-MOBILE-013",
    "TC-FILE-OPEN-001", "TC-FILE-OPEN-002", "TC-FILE-OPEN-003",
    "TC-FILE-OPEN-004", "TC-FILE-OPEN-005", "TC-FILE-OPEN-006",
    "TC-FILE-OPEN-007", "TC-FILE-OPEN-008", "TC-FILE-OPEN-009", "TC-FILE-OPEN-010", "TC-FILE-OPEN-011", "TC-FILE-OPEN-012", "TC-FILE-OPEN-013",
    "TC-TAO-HOME-002",
    "TC-EXPLORER-013", "TC-FILE-OPEN-041", "TC-FILE-OPEN-049", "TC-MODULES-102",
    "TC-TAOFFICE-001", "TC-TAOFFICE-009", "TC-TAOFFICE-033", "TC-TAOFFICE-034",
    "TC-TAOFFICE-039", "TC-TAOFFICE-040", "TC-TAOFFICE-041", "TC-TAOFFICE-042",
    "TC-TAOFFICE-043", "TC-TAOFFICE-044", "TC-TAOFFICE-045", "TC-TAOFFICE-046",
    "TC-TAOFFICE-047", "TC-TAOFFICE-048",
}
BROWSER_ONLY = {
    "TC-WS-055", "TC-IDE-C8-08-code-style-dialog-lifecycle-browser", "TC-MOBILE-012",
    "TC-FILE-OPEN-001", "TC-FILE-OPEN-004", "TC-TAOFFICE-033", "TC-TAOFFICE-039",
    "TC-TAOFFICE-041", "TC-TAOFFICE-043", "TC-TAOFFICE-044", "TC-TAOFFICE-047",
}
NATIVE_ONLY = {
    "TC-WS-051", "TC-WS-054", "TC-WS-056", "TC-MOBILE-013", "TC-FILE-OPEN-002",
    "TC-FILE-OPEN-007", "TC-FILE-OPEN-009", "TC-FILE-OPEN-011", "TC-TAO-HOME-002",
    "TC-TAOFFICE-034", "TC-TAOFFICE-040", "TC-TAOFFICE-042", "TC-TAOFFICE-045", "TC-TAOFFICE-046",
    "TC-TAOFFICE-048",
}


class CrashRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = discover(ROOT / "qa-ui-auto-tests/cases")
        cls.features = load_features(ROOT / "qa-ui-auto-tests/feature-list.md")

    def test_tag_and_smoke_keep_every_reported_crash_and_boundary_case(self):
        cases = [c for c in self.cases if "crash-regression" in c.tags]
        self.assertEqual({c.id for c in cases}, EXPECTED)
        policy = yaml.safe_load((ROOT / "qa-ui-auto-tests/ci/policy.yaml").read_text())
        self.assertTrue(EXPECTED.issubset(policy["smoke"]))
        for case in cases:
            with self.subTest(case=case.id):
                self.assertIn("browser" if case.id in BROWSER_ONLY else "native", case.modes)
                self.assertTrue(any("assert_no_runtime_errors" in step for step in case.steps))
                self.assertIsNone(case.skip)

    def test_full_tag_plans_all_three_packaged_release_webviews_and_browser_cases(self):
        args = argparse.Namespace(scope="selected", head="", base="", platforms="linux,windows,macos",
                                  modes="browser,native", case_ids="", features="", tags="crash-regression",
                                  shards="1", browser_workers=2)
        plan = make_plan(args, cases=self.cases, features=self.features)
        self.assertFalse(plan["gaps"])
        self.assertEqual(len(plan["entries"]), 6)
        for entry in plan["entries"]:
            expected = EXPECTED - (BROWSER_ONLY if entry["mode"] == "native" else NATIVE_ONLY)
            self.assertEqual(set(entry["selected_ids"]), expected)
            self.assertEqual("release" in entry["capabilities"], entry["mode"] == "native")

    def test_single_mode_tag_keeps_every_applicable_crash_without_scheduling_other_mode(self):
        for mode, excluded in (("browser", NATIVE_ONLY), ("native", BROWSER_ONLY)):
            with self.subTest(mode=mode):
                args = argparse.Namespace(scope="selected", head="", base="", platforms="linux,windows,macos",
                                          modes=mode, case_ids="", features="", tags="crash-regression",
                                          shards="1", browser_workers=2)
                plan = make_plan(args, cases=self.cases, features=self.features)
                self.assertFalse(plan["gaps"])
                self.assertEqual(len(plan["entries"]), 3)
                for entry in plan["entries"]:
                    self.assertEqual(entry["mode"], mode)
                    self.assertEqual(set(entry["selected_ids"]), EXPECTED - excluded)
                self.assertEqual(bool(plan["builds"]), mode == "native")

    def test_literal_case_ids_still_fail_when_the_requested_mode_cannot_execute_them(self):
        for mode, case_id in (("browser", "TC-FILE-OPEN-007"), ("native", "TC-FILE-OPEN-004")):
            with self.subTest(mode=mode):
                args = argparse.Namespace(scope="selected", head="", base="", platforms="linux",
                                          modes=mode, case_ids=case_id, features="", tags="crash-regression",
                                          shards="1", browser_workers=2)
                with self.assertRaisesRegex(ValueError, "explicit cases unavailable"):
                    make_plan(args, cases=self.cases, features=self.features)

    def test_pr_and_focused_workflow_entries_keep_crash_suite(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/qa-ui-auto-platforms.yml").read_text())
        plan = workflow["jobs"]["plan"]
        self.assertNotIn("if", plan, "PR planning must not be skipped")
        env = next(s["env"] for s in plan["steps"] if s.get("name") == "Plan exact cases and dependencies")
        self.assertIn("github.event_name == 'pull_request' && 'selected'", env["QA_SCOPE"])
        self.assertIn("github.event_name == 'pull_request' && 'crash-regression,ui-contract'", env["QA_TAGS"])
        self.assertIn("inputs.scope == 'selected' || inputs.scope == 'impacted'", env["QA_TAGS"])
        self.assertIn("format('{0},crash-regression,ui-contract', inputs.tags)", env["QA_TAGS"])
        triggers = workflow.get("on", workflow.get(True))
        dispatch_inputs = triggers["workflow_dispatch"]["inputs"]
        self.assertNotIn("quick", dispatch_inputs)
        self.assertNotIn("QA_QUICK", env)
        self.assertNotIn("concurrency", workflow)
        self.assertEqual(dispatch_inputs["platforms"]["default"], "linux,windows,macos")
        self.assertEqual(dispatch_inputs["modes"]["default"], "browser,native")
        self.assertNotIn("inputs.quick", env["QA_TAGS"])
        self.assertEqual(workflow["jobs"]["summarize"]["name"], "qa-ui-auto-platforms-result")
        self.assertNotIn("!inputs.quick", workflow["jobs"]["publish-issues"]["if"])
        paths = triggers["pull_request"]["paths"]
        for path in ["src/**", "src-tauri/src/**", "src-tauri/crates/**", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches/**", "src-tauri/Cargo.lock"]:
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
