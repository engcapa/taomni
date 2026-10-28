"""Contract checks for truthful forwarding observation, without launching any UI."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from qa_ui_auto import language_startup_observer as observer
from qa_ui_auto.steps import StepError


class LanguageStartupObservationTest(unittest.TestCase):
    def test_pending_fulfilled_and_rejected_calls_are_distinguished(self):
        state = {"events": [
            {"command": "sdk_resolve_workspace", "status": "pending"},
            {"command": "sdk_resolve_workspace", "status": "fulfilled"},
            {"command": "lsp_open_document", "status": "rejected"},
        ]}
        self.assertEqual(observer.mismatches(state, {
            "sdk_resolve_workspace": {"equal": 2, "pending": 1, "fulfilled": 1, "rejected": 0},
            "lsp_open_document": {"min": 1, "max": 1, "rejected": 1},
        }), [])
        self.assertTrue(observer.mismatches(state, {"sdk_resolve_workspace": {"pending": 0}}))
        with self.assertRaises(StepError):
            observer.mismatches(None, {})

    def test_invalid_bounds_cannot_turn_a_missing_observation_into_success(self):
        for args in [None, {}, {"commands": {}},
                     {"commands": {"arbitrary_ipc": {"equal": 0}}},
                     {"commands": {"sdk_get_registry": {"equal": True}}},
                     {"commands": {"sdk_get_registry": {"equal": -1}}},
                     {"commands": {"sdk_get_registry": {"equals": 0}}},
                     {"commands": {"sdk_get_registry": {"equal": 0}}, "quiet_ms": 2001}]:
            with self.subTest(args=args), self.assertRaises(StepError):
                observer.validate_expectations(args)

    def test_zero_count_requires_the_whole_quiet_interval_and_retains_independent_json(self):
        elapsed = [0.0]
        reads = []

        def read():
            reads.append(elapsed[0])
            return {"events": []}

        def sleep(seconds):
            elapsed[0] += seconds

        with tempfile.TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory))
            with patch.object(observer.time, "monotonic", side_effect=lambda: elapsed[0]), \
                    patch.object(observer.time, "sleep", side_effect=sleep):
                observer.assert_observation(ctx, {"commands": {"sdk_get_registry": {"equal": 0}}, "quiet_ms": 200}, read)
            self.assertGreaterEqual(reads[-1] - reads[0], .2)
            artifact = json.loads((ctx.case_dir / "language-startup-observation-01.json").read_text())
            self.assertEqual(artifact["mismatches"], [])
            self.assertEqual(artifact["quietMs"], 200)

    def test_failure_still_retains_the_actual_invocations(self):
        elapsed = [0.0]

        def sleep(seconds):
            elapsed[0] += seconds

        state = {"events": [{"command": "sdk_get_registry", "status": "fulfilled"}]}
        with tempfile.TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory))
            with patch.object(observer.time, "monotonic", side_effect=lambda: elapsed[0]), \
                    patch.object(observer.time, "sleep", side_effect=sleep):
                with self.assertRaisesRegex(StepError, "got 1"):
                    observer.assert_observation(ctx, {"commands": {"sdk_get_registry": {"equal": 0}}}, lambda: state)
            artifact = json.loads((ctx.case_dir / "language-startup-observation-01.json").read_text())
            self.assertEqual(artifact["state"], state)
            self.assertTrue(artifact["mismatches"])


if __name__ == "__main__":
    unittest.main()
