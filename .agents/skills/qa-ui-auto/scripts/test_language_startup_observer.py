"""Contract checks for truthful forwarding observation, without launching any UI."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto import language_startup_observer as observer
from qa_ui_auto.steps import StepError


class LanguageStartupObservationTest(unittest.TestCase):
    @staticmethod
    def state(events):
        return {"valid": True, "transport": "browser-invoke", "events": events}

    def test_pending_fulfilled_and_rejected_calls_are_distinguished(self):
        state = self.state([
            {"command": "sdk_resolve_workspace", "status": "pending"},
            {"command": "sdk_resolve_workspace", "status": "fulfilled"},
            {"command": "lsp_open_document", "status": "rejected"},
        ])
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

    def test_zero_counts_require_verified_transport_and_control_callback(self):
        valid = {"valid": True, "transport": "tauri-fetch-callbacks", "events": [],
                 "transportProbe": {"observed": True, "status": "fulfilled"}}
        expected = {"sdk_get_registry": {"equal": 0}}
        self.assertEqual(observer.mismatches(valid, expected), [])
        for state in [{"events": []}, {**valid, "valid": False},
                      {**valid, "observationError": "custom-protocol-failed"},
                      {**valid, "transport": "unverified"},
                      {**valid, "transportProbe": {"observed": False, "status": "fulfilled"}},
                      {**valid, "transportProbe": {"observed": True, "status": "pending"}}]:
            with self.subTest(state=state), self.assertRaises(StepError):
                observer.mismatches(state, expected)

    def test_native_install_waits_for_observed_real_control_callback_and_retains_it(self):
        ready = {"valid": True, "transport": "tauri-fetch-callbacks", "events": [],
                 "observationError": None, "transportProbe": {"observed": True, "status": "fulfilled"}}
        pending = {**ready, "valid": False, "transportProbe": {"observed": True, "status": "pending"}}
        with tempfile.TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory), session=Mock())
            ctx.session.execute.side_effect = [{"installed": True, "forwarding": True}, pending, ready]
            with patch.object(observer.time, "sleep") as sleep:
                observer.install_native(ctx)
            sleep.assert_called_once()
            self.assertEqual(json.loads((ctx.case_dir / "language-startup-transport.json").read_text()), ready)

    def test_native_install_cannot_accept_an_unobserved_control_response(self):
        elapsed = [0.0]

        def sleep(seconds):
            elapsed[0] += seconds

        invalid = {"valid": False, "transport": "tauri-fetch-callbacks", "events": [],
                   "transportProbe": {"observed": False, "status": "pending"}}
        for state in [invalid, {**invalid, "observationError": "control-request-bypassed-observer"}]:
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                elapsed[0] = 0
                ctx = SimpleNamespace(case_dir=Path(directory), session=Mock())
                count = [0]

                def execute(script):
                    count[0] += 1
                    return {"installed": True, "forwarding": True} if count[0] == 1 else state

                ctx.session.execute.side_effect = execute
                with patch.object(observer.time, "monotonic", side_effect=lambda: elapsed[0]), \
                        patch.object(observer.time, "sleep", side_effect=sleep):
                    with self.assertRaises(StepError):
                        observer.install_native(ctx)
                self.assertEqual(json.loads((ctx.case_dir / "language-startup-transport.json").read_text()), state)

    def test_zero_count_requires_the_whole_quiet_interval_and_retains_independent_json(self):
        elapsed = [0.0]
        reads = []

        def read():
            reads.append(elapsed[0])
            return self.state([])

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

        state = self.state([{"command": "sdk_get_registry", "status": "fulfilled"}])
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
