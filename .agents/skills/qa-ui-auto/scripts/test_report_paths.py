import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from qa_ui_auto.report_paths import summaries
from qa_ui_auto.verification import load_observations


class ReportDiscoveryTest(TestCase):
    def test_nested_reports_are_discovered_without_fixture_or_profile_noise(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            valid = root / "task/runs/run-1/summary.json"
            for relative in ("task/runs/run-1", "node_modules/pkg", "native-appcache/cache", "baseline"):
                folder = root / relative
                folder.mkdir(parents=True)
                (folder / "summary.json").write_text(json.dumps({"dry_run": True}), encoding="utf-8")
            (root / "baseline/.git").write_text("gitdir: unused", encoding="utf-8")
            self.assertEqual(summaries(root), [valid])
            self.assertEqual(summaries(valid.parent), [valid])
            self.assertEqual(summaries(valid), [valid])
            # The actual observation reader must find and reject dry-runs even
            # when passed a parent task root, deduplicating overlapping inputs.
            observations, rejected = load_observations([root, valid.parent, valid], {})
            self.assertEqual(observations, {})
            self.assertEqual(len(rejected), 1)
            self.assertIn("dry-run", rejected[0]["reason"])

    def test_missing_root_yields_no_evidence(self):
        with TemporaryDirectory() as tmp:
            self.assertEqual(summaries(Path(tmp) / "missing"), [])
