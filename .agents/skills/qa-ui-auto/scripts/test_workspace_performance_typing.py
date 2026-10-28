"""Native benchmark input must retain slow keys without hiding real failures."""
from copy import deepcopy
import json
import math
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest import TestCase

from qa_ui_auto.steps import StepError
from workspace_perf import common, native_input


def sample(keys, label="typing-group1", limit=150, latency=639):
    values = [30] * (len(keys) - 1) + [latency]
    frames = [value + 20 for value in values]
    index = math.ceil(len(keys) * .95) - 1
    return {
        "label": label, "captureText": False, "sampleCount": len(keys),
        "keydownCount": len(keys), "pendingKeyCount": 0,
        "thresholdP95Ms": limit, "keys": [{"key": key} for key in keys],
        "samples": [{"key": key, "mutationLatencyMs": value,
                     "nextFrameLatencyMs": frame}
                    for key, value, frame in zip(keys, values, frames)],
        "latencyMs": sorted(values), "nextFrameLatencyMs": sorted(frames),
        "p95Ms": sorted(values)[index], "maxMs": max(values),
        "nextFrameP95Ms": sorted(frames)[index],
    }


class Session:
    def __init__(self, failure=None):
        self.calls = []
        self.failure = failure

    def type_text(self, keys):
        self.calls.append(keys)
        if self.failure is not None and len(self.calls) == 2:
            raise self.failure

    def execute(self, script):
        return script


class InputDeliveryTest(TestCase):
    def test_every_key_is_sent_once_in_bounded_original_input_calls(self):
        original = Session()
        session = native_input.BatchedInputSession(original)
        keys = "abcdefghijklmnopqrstuvwxyz12345"
        session.type_text(keys)
        self.assertEqual(original.calls, [keys[0:8], keys[8:16], keys[16:24], keys[24:]])
        self.assertEqual("".join(original.calls), keys)
        self.assertEqual(session.execute("original executor"), "original executor")

    def test_uncertain_partial_input_is_never_retried(self):
        failure = TimeoutError("original input timeout")
        original = Session(failure)
        with self.assertRaises(TimeoutError) as caught:
            native_input.BatchedInputSession(original).type_text("a" * 200)
        self.assertIs(caught.exception, failure)
        self.assertEqual(original.calls, ["a" * 8, "a" * 8])


class MeasurementTest(TestCase):
    def test_slow_complete_tail_is_retained_and_stays_over_budget(self):
        raw = sample("a" * 8)
        original = deepcopy(raw)
        result = native_input.review_sample(raw, keys="a" * 8, label="typing-group1", limit=150)
        self.assertFalse(result["budgetPassed"])
        self.assertEqual(result["p95Ms"], 639)
        self.assertEqual(raw, original)

    def test_lost_keys_unfinished_frames_and_modified_tails_are_rejected(self):
        keys = "abcdefgh"
        original = sample(keys)
        patches = [
            {"sampleCount": 7}, {"keydownCount": 9}, {"pendingKeyCount": 1},
            {"label": "wrong-group"}, {"thresholdP95Ms": 1000},
            {"keys": [{"key": key} for key in reversed(keys)]},
            {"samples": original["samples"][:-1]},
            {"latencyMs": [30] * 8}, {"p95Ms": 30},
            {"nextFrameP95Ms": None},
            {"samples": [*original["samples"][:-1],
                         {**original["samples"][-1], "nextFrameLatencyMs": None}]},
        ]
        for patch in patches:
            with self.subTest(patch=list(patch)), self.assertRaises(ValueError):
                native_input.review_sample({**original, **patch}, keys=keys,
                                     label="typing-group1", limit=150)

    def test_only_the_complete_final_budget_error_can_continue_collection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = Session()
            ctx = SimpleNamespace(case_dir=root, session=original)
            raw = sample("a" * 8)
            path = root / "native-editor-performance-typing-group1.json"

            def verb(context, args):
                context.session.type_text(args["keys"])
                path.write_text(json.dumps(raw))
                raise StepError("native editor input p95 639.00 ms exceeds 150.00 ms (8 samples)")

            result = native_input.measure(ctx, verb, selector=".editor", keys="a" * 8,
                                    label="typing-group1", limit=150)
            self.assertFalse(result["budgetPassed"])
            self.assertIs(ctx.session, original)
            self.assertEqual(json.loads(path.read_text()), raw)
            failure = StepError("original focus failure")

            def fail(_context, _args):
                raise failure

            with self.assertRaises(StepError) as caught:
                native_input.measure(ctx, fail, selector=".editor", keys="a" * 8,
                               label="typing-group1", limit=150)
            self.assertIs(caught.exception, failure)
            self.assertIs(ctx.session, original)

    def test_transport_failure_restores_the_session_and_stops_remaining_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            failure = TimeoutError("original native input timeout")
            original = Session(failure)
            ctx = SimpleNamespace(case_dir=Path(directory), session=original)
            with self.assertRaises(TimeoutError) as caught:
                native_input.measure(ctx, lambda c, a: c.session.type_text(a["keys"]),
                               selector=".editor", keys="a" * 200,
                               label="typing-group1", limit=150)
            self.assertIs(caught.exception, failure)
            self.assertIs(ctx.session, original)
            self.assertEqual(len(original.calls), 2)


class ComparisonBudgetTest(TestCase):
    def records(self, root, *, candidate_latency):
        records = {}
        for label in ["main-1", "candidate-1", "main-2", "candidate-2"]:
            folder = root / label / "explorer"
            folder.mkdir(parents=True)
            latency = candidate_latency if label.startswith("candidate") else 639
            for group, keys, limit in [("typing-warmup", "w" * 24, 1000),
                                       ("typing-group1", "a" * 200, 150),
                                       ("typing-group2", "b" * 200, 150)]:
                # A sustained slow baseline, rather than a discarded outlier.
                raw = sample(keys, group, limit, latency)
                for row in raw["samples"]:
                    row["mutationLatencyMs"] = latency
                    row["nextFrameLatencyMs"] = latency + 20
                raw.update(latencyMs=[latency] * len(keys), p95Ms=latency,
                           nextFrameLatencyMs=[latency + 20] * len(keys),
                           nextFrameP95Ms=latency + 20)
                (folder / f"native-editor-performance-{group}.json").write_text(json.dumps(raw))
            budget = native_input.review_round(folder)
            records[label] = {"passed": budget["passed"], "metrics": {"explorer": {
                "inputBudgetPassed": budget["passed"], "inputBudgets": budget["groups"],
            }}}
        return records

    def test_over_budget_baseline_is_recorded_false_without_blocking_valid_comparison(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = self.records(root, candidate_latency=100)
            result = native_input.review_comparison(root, records)
            self.assertTrue(result["candidatePassed"])
            self.assertFalse(result["rounds"]["main-1"]["passed"])
            self.assertFalse(records["main-1"]["passed"])

    def test_candidate_faster_than_bad_baseline_still_must_meet_original_150ms_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = self.records(root, candidate_latency=151)
            result = native_input.review_comparison(root, records)
            self.assertFalse(result["candidatePassed"])
            records["candidate-1"]["passed"] = True
            with self.assertRaises(ValueError):
                native_input.review_comparison(root, records)


class CleanupFailureTest(TestCase):
    def test_cleanup_retains_the_original_failure_and_records_its_own_failure(self):
        diagnostics = {}
        session = SimpleNamespace(close=lambda: (_ for _ in ()).throw(RuntimeError("cleanup failure")))
        original = TimeoutError("original input timeout")
        with self.assertRaises(TimeoutError) as caught:
            try:
                raise original
            finally:
                common.close_session(session, diagnostics)
        self.assertIs(caught.exception, original)
        self.assertEqual(diagnostics["sessionCleanupError"]["message"], "cleanup failure")

    def test_cleanup_failure_after_success_remains_a_failure(self):
        session = SimpleNamespace(close=lambda: (_ for _ in ()).throw(RuntimeError("cleanup failure")))
        with self.assertRaisesRegex(RuntimeError, "cleanup failure"):
            common.close_session(session, {})
