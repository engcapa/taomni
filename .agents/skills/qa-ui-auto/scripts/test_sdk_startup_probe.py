"""Reject false pending-SDK evidence and always release a failed probe's child."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from qa_ui_auto.sdk_startup_probe import pending_child, run
from qa_ui_auto.steps import StepError, get
from qa_ui_auto.native_steps import VERBS


class SdkStartupProbeTest(unittest.TestCase):
    def test_fresh_waiting_heartbeat_from_the_same_unreleased_child_is_required(self):
        waiting = {"pid": 123, "phase": "waiting", "epochMs": 1000}
        started = {"pid": 123, "phase": "started", "epochMs": 900}
        self.assertEqual(pending_child([started, waiting], 1100, 123), waiting)
        for events, now, pid in [([], 1100, 123), ([waiting], 1100, 123),
                                 ([started, waiting], 1600, 123),
                                 ([started, waiting], 1100, 124), ([started, waiting], 900, 123),
                                 ([started, waiting, {"pid": 123, "phase": "released"}], 1100, 123),
                                 ([started, waiting, {"pid": 123, "phase": "rejected"}], 1100, 123),
                                 ([started, waiting, {"pid": 123, "phase": "fixture-timeout"}], 1100, 123),
                                 ([started, {**waiting, "epochMs": 6000}], 6000, 123)]:
            with self.subTest(events=events, now=now, pid=pid), self.assertRaises(StepError):
                pending_child(events, now, pid)

    def test_input_failure_retains_original_failure_and_releases_gate_despite_observer_disconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events, gate = root / "events.jsonl", root / "release"
            events.write_text("")
            ctx = SimpleNamespace(case_dir=root, session=Mock())
            original = RuntimeError("real input failed")
            ctx.session.dblclick.side_effect = original
            ctx.session.execute.side_effect = [
                {"valid": True, "transport": "tauri-fetch-callbacks", "events": [],
                 "transportProbe": {"observed": True, "status": "fulfilled"}},
                RuntimeError("renderer disconnected"),
            ]
            with self.assertRaises(RuntimeError) as result:
                run(ctx, {"events": str(events), "gate": str(gate)})
            self.assertIs(result.exception, original)
            self.assertTrue(gate.is_file())
            report = json.loads((root / "sdk-startup-responsiveness.json").read_text())
            self.assertFalse(report["passed"])
            self.assertEqual(report["actions"][0]["label"], "open-source")
            self.assertFalse(report["actions"][0]["passed"])
            self.assertIn("disconnected", report["captureError"])

    def test_invalid_transport_fails_before_input_and_still_releases_sdk_child(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events, gate = root / "events.jsonl", root / "release"
            events.write_text("")
            ctx = SimpleNamespace(case_dir=root, session=Mock())
            ctx.session.execute.return_value = {"events": [], "valid": False}
            with self.assertRaisesRegex(StepError, "zero counts are not evidence"):
                run(ctx, {"events": str(events), "gate": str(gate)})
            ctx.session.dblclick.assert_not_called()
            self.assertTrue(gate.is_file())
            report = json.loads((root / "sdk-startup-responsiveness.json").read_text())
            self.assertFalse(report["passed"])
            self.assertEqual(report["actions"], [])

    def test_paths_outside_case_and_already_released_gate_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "case"
            case.mkdir()
            ctx = SimpleNamespace(case_dir=case, session=Mock())
            with self.assertRaisesRegex(StepError, "belong to this"):
                run(ctx, {"events": str(root / "events"), "gate": str(case / "release")})
            gate = case / "release"
            gate.write_text("already released")
            with self.assertRaisesRegex(StepError, "already exists"):
                run(ctx, {"events": str(case / "events"), "gate": str(gate)})
            ctx.session.dblclick.assert_not_called()

    def test_source_language_and_unknown_arguments_fail_closed(self):
        for args in [{"events": "events", "gate": "gate", "language": "python"},
                     {"events": "events", "gate": "gate", "language": []},
                     {"events": "events", "gate": "gate", "source": "arbitrary-file"}]:
            with self.subTest(args=args), self.assertRaises(StepError):
                run(None, args)

    def test_both_observers_are_registered_but_real_process_probe_is_native_only(self):
        self.assertTrue(callable(get("observe_language_startup")))
        self.assertTrue(callable(get("assert_language_startup")))
        self.assertTrue(callable(VERBS["observe_language_startup"]))
        self.assertTrue(callable(VERBS["assert_language_startup"]))
        self.assertIs(VERBS["native_sdk_startup_probe"], run)
        with self.assertRaises(StepError):
            get("native_sdk_startup_probe")
        with self.assertRaisesRegex(StepError, "does not accept arguments"):
            VERBS["observe_language_startup"](None, {})


if __name__ == "__main__":
    unittest.main()
