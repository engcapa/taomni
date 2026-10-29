from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from qa_ui_auto import browser_tracing


class BrowserTracingTests(unittest.TestCase):
    def test_file_frame_probe_keeps_action_trace_without_snapshot_or_screencast(self):
        context = Mock()
        report = browser_tracing.start(context, {"steps": [
            {"open": "http://fixture"}, {"measure_workspace_file_open": {"label": "cold"}},
        ]})
        context.tracing.start.assert_called_once_with(screenshots=False, snapshots=False, sources=False)
        self.assertEqual(report, {"screenshots": False, "snapshots": False, "sources": False, "started": True})

    def test_other_cases_retain_full_trace_recording(self):
        for steps in [[], [{"click": "button"}], [{"measure_terminal_input": {}}]]:
            with self.subTest(steps=steps):
                context = Mock()
                browser_tracing.start(context, {"tags": ["performance"], "steps": steps})
                context.tracing.start.assert_called_once_with(screenshots=True, snapshots=True, sources=False)

    def test_trace_start_failure_is_explicit(self):
        context = Mock()
        context.tracing.start.side_effect = RuntimeError("recorder unavailable")
        report = browser_tracing.start(context, {"steps": []})
        self.assertFalse(report["started"])
        self.assertIn("recorder unavailable", report["error"])

    def test_failure_keeps_trace_and_existing_screenshot_html(self):
        context = Mock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            case = root / "case"
            failure = {"message": "slow frame", "artifacts": {"screenshot": "case/failure.png", "html": "case/failure.html"}}
            browser_tracing.stop(context, case, root, failure)
            context.tracing.stop.assert_called_once_with(path=str(case / "trace.zip"))
        self.assertEqual(failure["message"], "slow frame")
        self.assertEqual(failure["artifacts"], {"screenshot": "case/failure.png", "html": "case/failure.html", "trace": "case/trace.zip"})

    def test_passing_case_discards_trace(self):
        context = Mock()
        browser_tracing.stop(context, Path("report/case"), Path("report"), None)
        context.tracing.stop.assert_called_once_with()

    def test_stop_failure_preserves_original_failure_and_does_not_invent_trace(self):
        context = Mock()
        context.tracing.stop.side_effect = RuntimeError("closed browser")
        failure = {"message": "slow frame", "artifacts": {"screenshot": "failure.png"}}
        browser_tracing.stop(context, Path("report/case"), Path("report"), failure)
        self.assertEqual(failure, {"message": "slow frame", "artifacts": {"screenshot": "failure.png"}})


if __name__ == "__main__":
    unittest.main()
