from unittest import TestCase
from unittest.mock import patch

from qa_ui_auto.behavior_contract import execution_contract, validate_contract
from qa_ui_auto.exact_assertions import assert_exact
from qa_ui_auto.steps import StepError


class BehaviorContractTest(TestCase):
    def contract(self):
        return {"review": "reviewed", "requirements": [{
            "id": "R1", "requirement": "Cancel preserves the whole buffer",
            "actions": [1], "checkpoints": [{"step": 2, "expectation": "Both lines unchanged"}],
            "results": [2],
        }], "visual": [], "native": []}

    def test_screenshot_cannot_be_a_result_assertion(self):
        errors = validate_contract({"verification": self.contract(),
                                    "steps": [{"click": "#cancel"}, {"screenshot": "cancel.png"}]})
        self.assertTrue(any("not an asserting" in e for e in errors))

    def test_missing_result_after_action_is_rejected(self):
        contract = self.contract()
        contract["requirements"][0]["actions"] = [3]
        errors = validate_contract({"verification": contract,
                                    "steps": [{"click": "#cancel"}, {"assert_items": {}}, {"click": "#save"}]})
        self.assertTrue(any("after the last" in e for e in errors))

    def test_failure_and_unexecuted_steps_do_not_become_passes(self):
        result = {"step_timings": [{"index": 1, "status": "passed"}]}
        self.assertEqual(execution_contract(self.contract(), result, dry_run=False)["requirements"][0]["status"], "unrun")
        result["step_timings"].append({"index": 2, "status": "failed"})
        self.assertEqual(execution_contract(self.contract(), result, dry_run=False)["requirements"][0]["status"], "failed")
        result["step_timings"][1]["status"] = "passed"
        self.assertEqual(execution_contract(self.contract(), result, dry_run=True)["requirements"][0]["status"], "unrun")
        self.assertEqual(execution_contract(self.contract(), result, dry_run=False)["requirements"][0]["status"], "passed")

    def reject(self, observed, expected, *, items):
        with patch("qa_ui_auto.exact_assertions.time.monotonic", side_effect=[0, 0, 11]), patch("qa_ui_auto.exact_assertions.time.sleep"):
            with self.assertRaises(StepError):
                assert_exact(lambda _: observed, {"selector": "#result", "equals": expected}, items=items)

    def test_exact_assertions_reject_partial_corruption_and_order_changes(self):
        self.reject(["wrong first line", "second needle line"], ["first needle line", "second needle line"], items=True)
        self.reject(["b", "a"], ["a", "b"], items=True)
        self.reject(["a", "b", "c"], ["a", "b"], items=True)

    def test_empty_or_duplicate_dom_does_not_satisfy_exact_text(self):
        self.reject([], "", items=False)
        self.reject(["ok", "ok"], "ok", items=False)
        self.reject(["not ok"], "ok", items=False)

    def test_exact_text_preserves_whitespace(self):
        self.reject(["ok\n"], "ok", items=False)
        assert_exact(lambda _: ["ok\n"], {"selector": "#result", "equals": "ok\n"}, items=False)
