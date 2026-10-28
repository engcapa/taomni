"""Diagnostic observation must preserve native requests, faults and cleanup."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch, sentinel

from qa_ui_auto.sdk_action_trace import capture


class SdkActionTraceTest(unittest.TestCase):
    def test_forwards_exact_requests_results_and_restores_the_original_owner(self):
        original = Mock(return_value=sentinel.response)
        session = SimpleNamespace(request=original, execute=Mock(side_effect=[True, {"inputs": []}]))
        secret_payload = {"secret": "not-an-artifact"}
        with tempfile.TemporaryDirectory() as directory:
            with capture(session, Path(directory)):
                self.assertIs(session.request("POST", "/actions", secret_payload), sentinel.response)
            raw = (Path(directory) / "sdk-action-trace.json").read_text()
            report = json.loads(raw)
        original.assert_called_once_with("POST", "/actions", secret_payload)
        self.assertIs(session.request, original)
        self.assertNotIn("not-an-artifact", raw)
        self.assertTrue(report["passed"])
        self.assertTrue(report["requests"][0]["passed"])
        self.assertEqual(report["requests"][0]["path"], "/actions")
        self.assertGreater(report["requests"][0]["startedEpochMs"], 0)
        self.assertGreaterEqual(report["requests"][0]["durationMs"], 0)

    def test_transport_failure_is_not_retried_or_hidden_by_capture_failure(self):
        failure = RuntimeError("original input failed")
        original = Mock(side_effect=failure)
        session = SimpleNamespace(request=original, execute=Mock(side_effect=[True, RuntimeError("disconnected")]))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError) as result:
                with capture(session, Path(directory)):
                    session.request("POST", "/actions", {})
            report = json.loads((Path(directory) / "sdk-action-trace.json").read_text())
        self.assertIs(result.exception, failure)
        original.assert_called_once()
        self.assertIs(session.request, original)
        self.assertFalse(report["passed"])
        self.assertFalse(report["requests"][0]["passed"])
        self.assertEqual(report["requests"][0]["errorType"], "RuntimeError")
        self.assertIn("disconnected", report["captureError"])

    def test_missing_renderer_cannot_establish_valid_diagnostics(self):
        session = SimpleNamespace(request=Mock(), execute=Mock(side_effect=[True, None]))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "renderer is unavailable"):
                with capture(session, Path(directory)):
                    pass
            report = json.loads((Path(directory) / "sdk-action-trace.json").read_text())
        self.assertFalse(report["passed"])

    def test_install_failure_still_restores_request_owner_and_retains_evidence(self):
        original = Mock()
        session = SimpleNamespace(request=original, execute=Mock(side_effect=[False, None]))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "failed to install"):
                with capture(session, Path(directory)):
                    self.fail("invalid trace must not enter its body")
            report = json.loads((Path(directory) / "sdk-action-trace.json").read_text())
        self.assertIs(session.request, original)
        self.assertFalse(report["passed"])

    def test_changed_request_owner_is_preserved_and_fails_diagnostics(self):
        original, replacement = Mock(), Mock()
        session = SimpleNamespace(request=original, execute=Mock(side_effect=[True, {}]))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "owner changed"):
                with capture(session, Path(directory)):
                    session.request = replacement
            report = json.loads((Path(directory) / "sdk-action-trace.json").read_text())
        self.assertIs(session.request, replacement)
        self.assertFalse(report["passed"])

    def test_artifact_write_error_cannot_hide_original_transport_failure(self):
        original_error = RuntimeError("original transport failure")
        original = Mock(side_effect=original_error)
        session = SimpleNamespace(request=original, execute=Mock(side_effect=[True, {}]))
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "write_text", side_effect=OSError("disk full")):
            with self.assertRaises(RuntimeError) as failure:
                with capture(session, Path(directory)):
                    session.request("POST", "/actions", {})
        self.assertIs(failure.exception, original_error)
        self.assertIs(session.request, original)


if __name__ == "__main__":
    unittest.main()
