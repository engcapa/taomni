"""Assertions for the real-provider probe, independent of model-generated text."""
import json
from pathlib import Path
import subprocess
import unittest

import yaml

from qa_ui_auto.steps import StepError
from qa_ui_auto.tao_real_scenarios import DETAIL, checkpoint, tail_visible
from qa_ui_auto.testcase import validate_doc


def state(**updates):
    value = dict(transport={"valid": True, "calls": [{"status": "fulfilled"}] * 2},
                 assistantCount=2, userCount=2, lastReplyLength=16, replyLength=1000,
                 markerRetained=True, errorCount=0, retryVisible=False,
                 credentialInvalid=False, noKeyVisible=False, running=False)
    value.update(updates)
    return value


class RealScenarioTests(unittest.TestCase):
    def test_visible_tail_requires_a_real_viewport_at_the_bottom_and_both_child_edges(self):
        good = dict(feedHeight=400, gap=0, topVisible=True, bottomVisible=True)
        self.assertTrue(tail_visible(good))
        for updates in ({"feedHeight": 0}, {"gap": 30}, {"topVisible": False}, {"bottomVisible": False}):
            with self.subTest(updates=updates):
                self.assertFalse(tail_visible({**good, **updates}))
        self.assertFalse(tail_visible(None))

    def test_completed_latest_reply_requires_context_marker_and_exact_message_counts(self):
        self.assertEqual(checkpoint(state(), 2, 2), "response-complete")
        for values in ({"markerRetained": False}, {"assistantCount": 3}, {"userCount": 1}):
            with self.subTest(values=values), self.assertRaises(StepError):
                checkpoint(state(**values), 2, 2)

    def test_old_reply_text_cannot_make_an_empty_latest_reply_pass(self):
        self.assertIsNone(checkpoint(state(lastReplyLength=0), 2, 2))

    def test_pending_callback_or_stream_is_not_completion(self):
        self.assertIsNone(checkpoint(state(running=True), 2, 2))
        self.assertIsNone(checkpoint(state(transport={"valid": True, "calls": [
            {"status": "fulfilled"}, {"status": "pending"}]}), 2, 2))
        self.assertIsNone(checkpoint(state(transport={"valid": True, "calls": []}), 2, 2))

    def test_duplicate_paid_invocation_and_earlier_rejection_fail(self):
        for calls in ([{"status": "fulfilled"}] * 3,
                      [{"status": "rejected"}, {"status": "fulfilled"}]):
            with self.subTest(calls=calls), self.assertRaises(StepError):
                checkpoint(state(transport={"valid": True, "calls": calls}), 2, 2)

    def test_only_explicit_invalid_credentials_with_retry_may_finish_early(self):
        self.assertEqual(checkpoint(state(errorCount=1, credentialInvalid=True,
                                          retryVisible=True, lastReplyLength=0), 2, 2), "credential-invalid")
        for values in ({"credentialInvalid": False, "retryVisible": True, "errorCategory": "network"},
                       {"credentialInvalid": True, "retryVisible": False}):
            with self.subTest(values=values), self.assertRaises(StepError):
                checkpoint(state(errorCount=1, **values), 2, 2)

    def test_unclassified_rejection_or_invalid_observer_cannot_pass(self):
        for transport in ({"valid": False, "calls": []},
                          {"valid": True, "calls": [{"status": "fulfilled"}, {"status": "rejected"}]}):
            with self.subTest(transport=transport), self.assertRaises(StepError):
                checkpoint(state(transport=transport), 2, 2)

    def test_stop_reply_does_not_require_the_other_threads_marker(self):
        self.assertEqual(checkpoint(state(markerRetained=False), 2, 2, marker=False), "response-complete")

    def test_readonly_detail_script_parses_without_executing_browser_code(self):
        script = DETAIL.replace("MARKER", json.dumps("TQfixture")).replace("DRAFT", json.dumps("QA draft"))
        result = subprocess.run(["node", "-e", "new Function(process.argv[1]);", script],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_registered_case_has_a_reviewed_valid_behavior_contract(self):
        path = Path(__file__).resolve().parents[4] / "qa-ui-auto-tests/cases/TC-TAO-HOME-011-native-real-deepseek-scenarios.testcase.yaml"
        self.assertEqual(validate_doc(yaml.safe_load(path.read_text(encoding="utf-8")), source=str(path)), [])


if __name__ == "__main__":
    unittest.main()
