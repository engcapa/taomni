"""Retain actual preview assertions while selecting before narrow overlay opens."""
import hashlib
import json
from pathlib import Path
import unittest

import yaml
from qa_ui_auto.behavior_contract import validate_contract
from qa_ui_auto.testcase import load_case

ROOT = Path(__file__).resolve().parents[4]
CASES = ROOT / "qa-ui-auto-tests/cases"


def case(suffix):
    path = next(CASES.glob("TC-FILE-OPEN-" + suffix + "-*.testcase.yaml"))
    return path, yaml.safe_load(path.read_text(encoding="utf-8"))


class PreviewCaseOrderTests(unittest.TestCase):
    def test_initial_named_selection_precedes_actual_preview_toolbar_open_on_all_three_cases(self):
        for suffix, name in [("003", "unsafe.svg"), ("005", "report.html"), ("012", "01-landscape.png")]:
            with self.subTest(case=suffix):
                path, document = case(suffix)
                steps = document["steps"]
                row = '[data-testid="explorer-file-row"][data-name="' + name + '"]'
                show = steps.index({"show_explorer_preview": None})
                self.assertEqual(steps[show - 1], {"click": row})
                self.assertEqual(steps[show - 2], {"wait_for": row})
                self.assertLess(show, steps.index({"click": '[data-testid="explorer-preview-open"]'}))
                self.assertEqual(validate_contract(document), [], path.name)
                load_case(path)

    def test_reopen_and_new_boundary_selection_collapse_only_overlay_with_real_escape(self):
        _, svg = case("003")
        row = '[data-testid="explorer-file-row"][data-name="unsafe.svg"]'
        reopen = svg["steps"].index({"dblclick": row})
        self.assertEqual(svg["steps"][reopen - 1], {"press": {"selector": '[data-testid="explorer-tab"][data-active="true"]', "key": "Escape"}})
        _, raster = case("012")
        target = '[data-testid="explorer-file-row"][data-name="91-preview-limit.png"]'
        select = raster["steps"].index({"click": target})
        self.assertEqual(raster["steps"][select - 1], {"press": {"selector": '[data-testid="explorer-tab"][data-active="true"]', "key": "Escape"}})
        self.assertEqual(raster["steps"][select + 1], {"show_explorer_preview": None})
        # Production Escape only clears rename/overlay after editable checks; it
        # does not toggle persisted preview preferences, navigate or close tabs.
        source = (ROOT / "src/components/explorer/ExplorerShell.tsx").read_text(encoding="utf-8")
        self.assertIn('else if (event.key === "Escape") { operations.setRenamePath(null); setPreviewOverlay(false); }', source)

    def test_all_original_wait_and_assertion_payloads_are_unchanged(self):
        # Frozen from d1c1f7e0 case payloads before the native-overlay ordering
        # correction. Never regenerate these to mask removed assertions.
        expected = {
            "003": (18, "6dc6ca55898455b2154a716743425082e45610a445d425bcffbbab42539cd585"),
            "005": (32, "0e024302f2611bc183e9c8ae68d0a42c4d31953b9b6f4718cb6575a49f693e7c"),
            "012": (47, "f18aaf379ae71bb3f4fbd4021460d7c11b760738c1f2890143bdbc8547c91db3"),
        }
        for suffix, (count, digest) in expected.items():
            _, document = case(suffix)
            checks = [step for step in document["steps"] if next(iter(step)).startswith("assert_") or next(iter(step)) in {"eval_readonly", "wait_for"}]
            self.assertEqual(len(checks), count)
            actual = hashlib.sha256(json.dumps(checks, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            self.assertEqual(actual, digest, suffix)


if __name__ == "__main__":
    unittest.main()
