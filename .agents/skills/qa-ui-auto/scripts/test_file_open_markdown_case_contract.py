"""TC-FILE-OPEN-004 additions must not weaken the original 120-step workflow.

Frozen payload digests were read from commit 7a08e692520cbdcba523395998525e606be8c166,
case blob 5f809e8b681e1917a98af3721725d58dda8a31f5, before any insertion.
They cover ALL original actions/data/assertions and all six original requirement
semantics, not merely a count of assertions. Never regenerate the digests to
accept an unrelated change. These tests launch no UI and need no Git executable.
"""
import copy
import hashlib
import json
from pathlib import Path
import unittest

import yaml

from qa_ui_auto.behavior_contract import validate_contract
from qa_ui_auto.testcase import load_case, validate_doc


ROOT = Path(__file__).resolve().parents[4]
CASE_PATH = ROOT / "qa-ui-auto-tests/cases/TC-FILE-OPEN-004-markdown-live-paste-export.testcase.yaml"
THEME_CASE = ROOT / "qa-ui-auto-tests/cases/TC-FILE-OPEN-007-native-markdown-artifacts.testcase.yaml"

# Each key is an ORIGINAL 1-based step after which new steps were inserted.
# Removing only these anchored ranges must reproduce the frozen original case.
INSERTIONS = {21: 5, 24: 2, 33: 1, 34: 22, 55: 1, 59: 13, 66: 2}
ORIGINAL_STEPS_SHA256 = "bf1cd07509e59fb7e69ef38de934162307d33cc285743eefdd733d48bad6c9d1"
ORIGINAL_REQUIREMENTS_SHA256 = "d8a08d4a459a318c43cbd343b82723396867b77f561a57e8746e037f27f622c0"


def digest(value):
    return hashlib.sha256(json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()).hexdigest()


def read_case():
    return yaml.safe_load(CASE_PATH.read_text(encoding="utf-8"))


def partition(document):
    original = []
    inserted = {}
    old_to_new = {}
    cursor = 0
    for old_index in range(1, 121):
        old_to_new[old_index] = cursor + 1
        original.append(document["steps"][cursor])
        cursor += 1
        count = INSERTIONS.get(old_index, 0)
        if count:
            inserted[old_index] = document["steps"][cursor:cursor + count]
            cursor += count
    if cursor != len(document["steps"]):
        raise AssertionError("Unexpected extra/missing steps outside explicit insertion ranges")
    return original, inserted, old_to_new


def click(testid):
    return {"click": '[data-testid="' + testid + '"]'}


def attribute(selector, name, value):
    return {"assert_attribute": {"selector": selector, "name": name, "equals": value}}


class MarkdownCaseContractTests(unittest.TestCase):
    def test_schema_and_reviewed_behavior_contract_accept_all_readonly_expressions(self):
        document = read_case()
        self.assertEqual(validate_doc(document, source=str(CASE_PATH)), [])
        self.assertEqual(validate_contract(document, require_review=True), [])
        self.assertEqual(len(load_case(CASE_PATH).steps), 166)
        self.assertEqual(document["modes"], ["browser"])
        self.assertEqual(document["fixtures"], ["reset_db", "file_open_files"])
        self.assertEqual(document["covers"], ["F-FILEOPEN-1", "F-EXPLORER-1"])

    def test_every_original_action_assertion_and_payload_remains_exact_and_ordered(self):
        original, _, _ = partition(read_case())
        self.assertEqual(len(original), 120)
        self.assertEqual(digest(original), ORIGINAL_STEPS_SHA256)
        # Includes the original HTML artifact checklist: do not append to it or
        # replace its Mermaid checks with checks of a second artifact.
        self.assertEqual(original[92]["assert_download"]["contains"], [
            "File open Markdown", "<table", "data:image/png;base64,", "Alpha",
            "<svg", "fv-md-mermaid", "Explorer", "OpenFile", "Viewer",
        ])

    def test_all_original_requirement_references_are_mechanically_remapped(self):
        document = read_case()
        original, _, old_to_new = partition(document)
        new_to_old = {new: old for old, new in old_to_new.items()}
        requirements = copy.deepcopy(document["verification"]["requirements"][:6])
        self.assertEqual([req["id"] for req in requirements], ["R1", "R2", "R3", "R4", "R5", "R6"])
        for req in requirements:
            for key in ("actions", "results"):
                for reference in req[key]:
                    self.assertIn(reference, new_to_old, (req["id"], key, reference))
                    self.assertEqual(document["steps"][reference - 1], original[new_to_old[reference] - 1])
                req[key] = [new_to_old[index] for index in req[key]]
            for checkpoint in req["checkpoints"]:
                self.assertIn(checkpoint["step"], new_to_old)
                checkpoint["step"] = new_to_old[checkpoint["step"]]
        self.assertEqual(digest(requirements), ORIGINAL_REQUIREMENTS_SHA256)

    def test_actual_live_widget_whitespace_and_compact_details_geometry_are_observed(self):
        _, additions, _ = partition(read_case())
        math, block, image, heading, geometry = additions[21]
        self.assertIn(".fv-md-math .katex", math["eval_readonly"]["expression"])
        expression = block["eval_readonly"]["expression"]
        self.assertIn('getComputedStyle(document.querySelector(".fv-md-rendered-block"))', expression)
        self.assertIn('getComputedStyle(document.querySelector(".fv-md-rendered-block p"))', expression)
        self.assertEqual(expression.count('.whiteSpace === "normal"'), 2)
        self.assertIn('getComputedStyle(document.querySelector(".fv-md-image")).whiteSpace === "normal"', image["eval_readonly"]["expression"])
        self.assertEqual(heading, {"assert_text_equals": {
            "selector": '[data-testid="markdown-live"] .fv-md-rendered-block h2', "equals": "Details",
        }})
        expression = geometry["eval_readonly"]["expression"]
        gap = ('document.querySelector(".fv-md-rendered-block h2").getBoundingClientRect().top'
               ' - document.querySelector(".fv-md-rendered-block p").getBoundingClientRect().bottom')
        self.assertEqual(expression, gap + " >= 0 && " + gap + " < 75")
        self.assertIn('getComputedStyle(document.querySelector(".fv-md-table-wrap")).whiteSpace === "normal"', additions[55][0]["eval_readonly"]["expression"])

    def test_heading_prefix_uses_computed_font_ratio_monospace_and_muted_color(self):
        _, additions, _ = partition(read_case())
        ratio, style = [step["eval_readonly"]["expression"] for step in additions[24]]
        measurement = ('parseFloat(getComputedStyle(document.querySelector(".fv-md-source-marker")).fontSize)'
                       ' / parseFloat(getComputedStyle(document.querySelector(".fv-md-heading-1")).fontSize)')
        self.assertEqual(ratio, measurement + " >= 0.7 && " + measurement + " <= 0.9")
        self.assertIn('.fontFamily.toLowerCase().includes("mono")', style)
        self.assertIn('.color !== getComputedStyle(document.querySelector(".fv-md-heading-1")).color', style)

    def test_dark_screenshots_use_existing_real_settings_controls_then_restore_light(self):
        document = read_case()
        _, additions, mapping = partition(document)
        theme = additions[34]
        native = yaml.safe_load(THEME_CASE.read_text(encoding="utf-8"))["steps"]
        viewer = {"click": '[data-testid="tab-item"][data-tab-type="file-viewer"]'}
        search = {"fill": {"selector": '[data-testid="settings-search-input"]', "value": "theme"}}
        dark = [click("ribbon-settings"), search, click("app-theme-select"), click("app-theme-dark"), viewer]
        light = [click("ribbon-settings"), search, click("app-theme-select"), click("app-theme-light"), viewer]
        for sequence in (dark, light):
            for step in sequence:
                self.assertIn(step, native, "Reuse TC007's production theme controls")
        self.assertEqual(theme[:6], dark[:2] + [{"wait_for": '[data-testid="app-theme-select"]'}] + dark[2:])
        self.assertEqual(theme[6], attribute("html", "data-app-theme", "dark"))
        self.assertEqual(theme[7], {"wait_for": '[data-testid="markdown-preview"] .fv-md-mermaid svg'})
        self.assertEqual(theme[9], {"screenshot": "markdown-split-mermaid-dark.png"})
        self.assertEqual(theme[10], click("markdown-mode-live"))
        self.assertEqual(theme[11], {"wait_for": '[data-testid="markdown-live"] .fv-md-mermaid svg'})
        self.assertEqual(theme[13], {"screenshot": "markdown-live-mermaid-dark.png"})
        for step, pane in ((theme[8], ".fv-md-preview-pane"), (theme[12], ".fv-md-live-surface")):
            expression = step["eval_readonly"]["expression"]
            self.assertIn(pane + " .fv-md-mermaid svg", expression)
            self.assertIn("getBoundingClientRect().width >= 200", expression)
            self.assertIn("getBoundingClientRect().height >= 30", expression)
        self.assertEqual(theme[14], click("markdown-mode-split"))
        self.assertEqual(theme[15:20], light)
        self.assertEqual(theme[20], attribute("html", "data-app-theme", "light"))
        self.assertEqual(theme[21], {"assert_file_open_bytes": {
            "path": "${fixture.file_open_root}/live.md", "sha256": "${fixture.file_open_markdown_sha}",
        }})
        # Entire theme detour is before the original source mode / first edit.
        self.assertEqual(document["steps"][mapping[35] - 1], click("markdown-mode-source"))
        self.assertEqual(mapping[35] - mapping[34], len(theme) + 1)

    def test_late_task_edit_exports_actual_checked_state_then_reverts_before_old_edit(self):
        document = read_case()
        original, additions, mapping = partition(document)
        task = '[data-testid="markdown-live"] .fv-md-task[aria-label="First task"]'
        marker = '[data-testid="markdown-preview"] .fv-md-task-state'
        self.assertEqual(additions[59], [
            attribute(task, "aria-checked", "false"),
            {"click": task},
            attribute(task, "aria-checked", "true"),
            click("markdown-mode-split"),
            attribute(marker, "data-task-checked", "true"),
            {"assert_text_equals": {"selector": marker, "equals": "☑"}},
            click("markdown-export"),
            {"assert_download": {
                "trigger": '[data-testid="markdown-export-html"]', "filename": "live.html",
                "contains": ["First task", "fv-md-task-state", 'data-task-checked="true"', "☑"],
            }},
            {"assert_text": {"selector": '[data-testid="markdown-export-status"]', "contains": "Export completed"}},
            click("markdown-mode-live"),
            {"click": task},
            attribute(task, "aria-checked", "false"),
            {"assert_count": {"selector": '[data-testid="file-viewer"][data-dirty="true"]', "equal": 0}},
        ])
        self.assertEqual(additions[66], [
            attribute(marker, "data-task-checked", "false"),
            {"assert_text_equals": {"selector": marker, "equals": "☐"}},
        ])
        # First task edit follows the original paste + Save, never the initial
        # hash oracle. Revert is complete before original table-cell edit/Save.
        self.assertLess(mapping[52], mapping[59])
        self.assertEqual(document["steps"][mapping[60] - 1], original[59])
        self.assertEqual(mapping[60] - mapping[59], len(additions[59]) + 1)
        self.assertEqual(len([step for step in additions[59] if "assert_download" in step]), 1)

    def test_new_requirement_maps_every_new_observation_and_real_action(self):
        document = read_case()
        _, _, mapping = partition(document)
        self.assertEqual(len(document["verification"]["requirements"]), 7)
        requirement = document["verification"]["requirements"][-1]
        self.assertEqual(requirement["id"], "R7")
        added_indices = set(range(1, len(document["steps"]) + 1)) - set(mapping.values())
        observations = {
            index for index in added_indices
            if next(iter(document["steps"][index - 1])) in {
                "eval_readonly", "assert_attribute", "assert_text_equals", "assert_text",
                "assert_count", "assert_file_open_bytes", "assert_download",
            }
        }
        self.assertEqual(set(requirement["results"]), observations)
        self.assertEqual({check["step"] for check in requirement["checkpoints"]}, set(requirement["results"]))
        actions = {
            index for index in added_indices
            if next(iter(document["steps"][index - 1])) in {"click", "fill", "assert_download"}
        }
        self.assertEqual(set(requirement["actions"]), actions)
        self.assertIn("separate visual review", requirement["requirement"])
        self.assertEqual(document["verification"]["visual"][0]["method"], "manual")


if __name__ == "__main__":
    unittest.main()
