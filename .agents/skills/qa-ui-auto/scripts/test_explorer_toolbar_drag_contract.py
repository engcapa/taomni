"""Preserve the retained file move oracle while adding toolbar reflow checks."""
import json
from pathlib import Path
import subprocess
from unittest import TestCase

import yaml
from qa_ui_auto.behavior_contract import validate_contract
from qa_ui_auto.testcase import load_case

ROOT = Path(__file__).resolve().parents[4]
RELATIVE = "qa-ui-auto-tests/cases/TC-EXPLORER-003-file-operations.testcase.yaml"
BASE = "d1c1f7e02b4aee848167481ea26c9953e3dfff8f"
EXPRESSION = 'Math.abs(document.querySelector(".ex-cmd").getBoundingClientRect().height - 36) <= 1'


class ExplorerToolbarDragContract(TestCase):
    def test_original_steps_and_all_checkpoints_survive_geometry_checks(self):
        document = yaml.safe_load((ROOT / RELATIVE).read_text(encoding="utf-8"))
        original = yaml.safe_load(subprocess.check_output(["git", "show", f"{BASE}:{RELATIVE}"], cwd=ROOT, text=True))
        extra = {"eval_readonly": {"expression": EXPRESSION, "expect_truthy": True}}
        self.assertEqual(document["steps"][102], extra)
        self.assertEqual(document["steps"][104], extra)
        reduced = [step for index, step in enumerate(document["steps"]) if index not in (102, 104)]
        self.assertEqual(reduced, original["steps"])
        inverse = lambda step: step - (1 if step >= 104 else 0) - (1 if step >= 106 else 0)
        for before, after in zip(original["verification"]["requirements"], document["verification"]["requirements"]):
            self.assertEqual([inverse(index) for index in after["actions"]], before["actions"])
            retained = [point for point in after["checkpoints"] if point["step"] not in (103, 105)]
            self.assertEqual([{**point, "step": inverse(point["step"])} for point in retained], before["checkpoints"])
            self.assertEqual([inverse(index) for index in after["results"] if index not in (103, 105)], before["results"])
        self.assertEqual(validate_contract(document), [])
        load_case(ROOT / RELATIVE)
