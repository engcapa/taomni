from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import yaml

from qa_ui_auto.ui_contract_gen import CASES, REGISTRY, dialog_case, sync


class DialogRegistryTests(unittest.TestCase):
    def test_every_checked_in_case_matches_its_entry(self):
        self.assertEqual(sync(REGISTRY, CASES, check=True), [])

    def test_check_detects_changed_removed_and_missing_cases(self):
        with TemporaryDirectory() as directory:
            cases = Path(directory)
            self.assertTrue(sync(REGISTRY, cases, check=True))
            self.assertEqual(sync(REGISTRY, cases, check=False), [])
            case = next(cases.glob("*.testcase.yaml"))
            case.write_text("stale", encoding="utf-8")
            orphan = cases / "TC-UIC-DLG-removed.testcase.yaml"
            orphan.write_text("old", encoding="utf-8")
            self.assertEqual(len(sync(REGISTRY, cases, check=True)), 2)
            self.assertEqual(case.read_text(encoding="utf-8"), "stale")

    def test_rejects_ids_outside_the_case_directory(self):
        entry = yaml.safe_load(REGISTRY.read_text(encoding="utf-8"))["dialogs"][0]
        with self.assertRaisesRegex(ValueError, "Invalid dialog slug"):
            dialog_case({**entry, "slug": "../bad"})
