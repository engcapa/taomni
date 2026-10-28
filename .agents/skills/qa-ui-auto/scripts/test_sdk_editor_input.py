"""Fail closed on missing keys, slow frames, changed text and transport faults."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto.sdk_editor_input import CLEANUP_SCRIPT, READ_SCRIPT, measure, review
from qa_ui_auto.steps import StepError


def sample(text):
    return {"keys": [{"key": key} for key in text], "frames": [
        {"key": key, "frameMs": 12, "document": text[:index + 1],
         "dom": text[:index + 1], "caret": index + 1, "keyCount": index + 1}
        for index, key in enumerate(text)], "inputs": []}


class SdkEditorInputTest(unittest.TestCase):
    def test_rejects_missing_reordered_duplicate_or_slow_samples_and_inexact_source(self):
        valid = sample("abc")
        review(valid, "abc")
        for field, replacement in [("keys", valid["keys"][:-1]),
                                    ("keys", list(reversed(valid["keys"]))),
                                    ("frames", valid["frames"] * 2)]:
            with self.subTest(field=field), self.assertRaises(StepError):
                review({**valid, field: replacement}, "abc")
        for field, value in [("frameMs", 150.01), ("frameMs", float("nan")),
                              ("frameMs", None), ("document", "abc}"),
                              ("dom", "abc}"), ("caret", 2),
                              ("keyCount", None), ("keyCount", 4), ("keyCount", True)]:
            changed = copy.deepcopy(valid)
            changed["frames"][-1][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(StepError):
                review(changed, "abc")

    def test_intermediate_autoclosing_bracket_is_retained_but_final_requires_exact_text(self):
        state = sample("{")
        state["frames"][-1].update(document="{}", dom="{}")
        original = copy.deepcopy(state)
        review(state, "{", exact=False)
        self.assertEqual(state, original)
        with self.assertRaises(StepError):
            review(state, "{")

    def test_frames_with_multiple_paced_keys_require_the_complete_observed_prefix(self):
        state = sample("abc")
        for frame in state["frames"][:2]:
            frame.update(document="ab", dom="ab", caret=2, keyCount=2)
        review(state, "abc")
        state["frames"][0]["document"] = "a"
        with self.assertRaisesRegex(StepError, "canonical editor"):
            review(state, "abc")
        state["frames"][0].update(document="abc", caret=3, keyCount=3)
        with self.assertRaisesRegex(StepError, "canonical editor"):
            review(state, "abc")

    def test_each_character_and_raw_sample_is_retained_in_original_paced_batches(self):
        typed = []
        text = "public class Main { int value = 7; }"
        session = Mock()
        session.type_text.side_effect = typed.append
        session.execute.side_effect = lambda script: sample("".join(typed)) if script in {READ_SCRIPT, CLEANUP_SCRIPT} else True
        pending = Mock(return_value={"pid": 77, "pending": True})
        with tempfile.TemporaryDirectory() as directory:
            report = measure(session, ".cm-content", text, Path(directory), pending)
            retained = json.loads((Path(directory) / "sdk-typing-responsiveness.json").read_text())
            self.assertEqual(retained, report)
        self.assertTrue(report["passed"])
        self.assertEqual(typed, [text[offset:offset + 8] for offset in range(0, len(text), 8)])
        self.assertEqual("".join(typed), text)
        self.assertEqual(pending.call_count, 5)
        self.assertEqual(report["keyActionBudgetMs"], 1500)
        self.assertEqual(report["keyFrameBudgetMs"], 150)
        self.assertEqual(report["batchSize"], 8)
        self.assertEqual(report["observation"], sample(text))
        self.assertEqual("".join(request["text"] for request in report["requests"]), text)
        self.assertEqual([(r["firstKey"], r["lastKey"]) for r in report["requests"]],
                         [(1, 8), (9, 16), (17, 24), (25, 32), (33, 36)])

    def test_a_completed_sdk_cannot_pass_from_fast_complete_typing_samples(self):
        session = Mock()
        session.execute.side_effect = [True, sample("abc"), sample("abc")]
        pending = Mock(side_effect=StepError("SDK child is no longer alive and waiting"))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(StepError, "no longer alive"):
                measure(session, ".cm-content", "abc", Path(directory), pending)
            report = json.loads((Path(directory) / "sdk-typing-responsiveness.json").read_text())
        self.assertFalse(report["passed"])
        self.assertFalse(report["requests"][0]["passed"])
        self.assertEqual(report["observation"], sample("abc"))

    def test_input_failure_stays_original_and_observer_cleanup_is_attempted(self):
        session = Mock()
        original = RuntimeError("native input failed")
        session.type_text.side_effect = original
        session.execute.side_effect = [True, RuntimeError("renderer disconnected")]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError) as failure:
                measure(session, ".cm-content", "abc", Path(directory), Mock())
            self.assertIs(failure.exception, original)
            report = json.loads((Path(directory) / "sdk-typing-responsiveness.json").read_text())
        self.assertFalse(report["passed"])
        self.assertFalse(report["requests"][0]["passed"])
        self.assertIn("disconnected", report["captureError"])
        self.assertEqual(session.execute.call_args.args, (CLEANUP_SCRIPT,))

    def test_missing_real_editor_never_dispatches_input_and_retains_failure(self):
        session = Mock()
        session.execute.return_value = False
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(StepError, "focused real editor"):
                measure(session, ".cm-content", "abc", Path(directory), Mock())
            report = json.loads((Path(directory) / "sdk-typing-responsiveness.json").read_text())
        self.assertFalse(report["passed"])
        session.type_text.assert_not_called()

    def test_slow_native_request_fails_even_when_the_delivered_key_has_a_fast_frame(self):
        session = Mock()
        session.execute.side_effect = [True, sample("a"), sample("a")]
        with tempfile.TemporaryDirectory() as directory, \
                patch("qa_ui_auto.sdk_editor_input.time.monotonic", side_effect=[0, 0, 2, 2, 2]):
            with self.assertRaisesRegex(StepError, "1500ms action budget"):
                measure(session, ".cm-content", "a", Path(directory), Mock(return_value={"pending": True}))
            report = json.loads((Path(directory) / "sdk-typing-responsiveness.json").read_text())
        self.assertFalse(report["passed"])
        self.assertEqual(report["requests"][0]["durationMs"], 2000)
        self.assertEqual(report["observation"], sample("a"))

    def test_a_missing_frame_does_not_pass_from_successful_input_delivery(self):
        session = Mock()
        missing = {"keys": [{"key": "a"}], "frames": [], "inputs": []}
        session.execute.side_effect = [True, missing, missing]
        with tempfile.TemporaryDirectory() as directory, \
                patch("qa_ui_auto.sdk_editor_input.time.monotonic", side_effect=[0, 0, 2, 2, 2]):
            with self.assertRaisesRegex(StepError, "frame did not appear"):
                measure(session, ".cm-content", "a", Path(directory), Mock())
            report = json.loads((Path(directory) / "sdk-typing-responsiveness.json").read_text())
        self.assertFalse(report["passed"])
        self.assertEqual(report["observation"], missing)


if __name__ == "__main__":
    unittest.main()
