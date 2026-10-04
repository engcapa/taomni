import json
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.screenshot_scenarios import SCENARIOS, run_scenario
from qa_ui_auto.steps import StepError


class ScreenshotScenariosTest(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ctx = Mock()
        self.ctx.case_dir = Path(self.tmp.name)

    def test_schema_and_runner_accept_the_same_native_scenarios(self):
        schema_path = Path(__file__).resolve().parent.parent / "schema" / "testcase.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        scenarios = schema["$defs"]["step"]["properties"]["native_screenshot_scenario"]["properties"]["scenario"]["enum"]
        self.assertEqual(len(scenarios), len(set(scenarios)))
        self.assertEqual(set(scenarios), set(SCENARIOS))

    def test_settles_promises_instead_of_serializing_pending_promise(self):
        self.ctx.session.execute.side_effect = [True, {"done": False},
            {"done": True, "value": 'OK {"frames":30}'}, True]
        with patch("qa_ui_auto.screenshot_scenarios.time.sleep"):
            result = run_scenario(self.ctx, {"scenario": "record", "format": "mp4", "secs": 3})
        self.assertIn("verified", result)
        script = self.ctx.session.execute.call_args_list[0].args[0]
        self.assertIn('"screenshot_qa_record"', script)
        self.assertIn(".then(", script)
        self.assertTrue(script.endswith("return true;"))
        evidence = json.loads(next(self.ctx.case_dir.glob("screenshot-record-mp4-*.json")).read_text())
        self.assertEqual(evidence["result"]["value"], 'OK {"frames":30}')

    def test_failure_and_rejection_are_not_passes_and_keep_evidence(self):
        for state in ({"done": True, "value": 'FAIL {"frames":2}'},
                      {"done": True, "error": "permission denied"},
                      {"done": True, "value": "OK {}"}):
            with self.subTest(state=state):
                self.ctx.session.execute.side_effect = [True, state, True]
                with self.assertRaises(StepError), patch("qa_ui_auto.screenshot_scenarios.time.sleep"):
                    run_scenario(self.ctx, {"scenario": "capture"})
                self.assertTrue(list(self.ctx.case_dir.glob("screenshot-capture-png-*.json")))

    def test_transport_failures_and_budget_timeouts_keep_evidence(self):
        from qa_ui_auto.deadline import CaseTimeout
        for error in (RuntimeError("bridge disconnected"), CaseTimeout("case expired")):
            with self.subTest(error=error):
                self.ctx.session.execute.side_effect = [True, error, True]
                with self.assertRaises((StepError, CaseTimeout)):
                    run_scenario(self.ctx, {"scenario": "capture"})
                files = list(self.ctx.case_dir.glob("screenshot-capture-png-*.json"))
                self.assertTrue(any(json.loads(path.read_text())["transportError"] == str(error) for path in files))

    def test_new_scenarios_only_invoke_their_fixed_commands(self):
        for scenario, command in (("pin-tools", "screenshot_qa_pin_tools"), ("scroll-manual", "screenshot_qa_scroll_manual"), ("colors", "screenshot_qa_colors"), ("capture-fidelity", "screenshot_qa_capture_fidelity"), ("ocr-redact", "screenshot_qa_ocr_redact"), ("freehand", "screenshot_qa_freehand"), ("controls", "screenshot_qa_controls"), ("full-recorder", "screenshot_qa_full_recorder"), ("scroll-permission-error", "screenshot_qa_scroll_permission_error"), ("capture-permission-error", "screenshot_qa_capture_permission_error")):
            self.ctx.session.execute.side_effect = [True, {"done": True, "value": 'OK {"pixels":100}'}, True]
            run_scenario(self.ctx, {"scenario": scenario})
            self.assertIn(command, self.ctx.session.execute.call_args_list[-3].args[0])

    def test_macos_source_passes_only_the_format_to_fixed_command(self):
        self.ctx.session.execute.side_effect = [True, {"done": True, "value": 'OK {"streamOpens":0,"snapshotReads":20}'}, True]
        run_scenario(self.ctx, {"scenario": "macos-capture-source", "format": "gif"})
        script = self.ctx.session.execute.call_args_list[0].args[0]
        self.assertIn('"screenshot_qa_macos_capture_source"', script)
        self.assertIn('{"format": "gif"}', script)

    def test_rejects_arbitrary_commands_and_invalid_arguments(self):
        for args in ({"scenario": "macos-capture-source"}, {"scenario": "macos-capture-source", "format": "gif", "secs": 2}, {"scenario": "shell_exec"}, {"scenario": "record"},
                     {"scenario": "pin", "format": "gif"},
                     {"scenario": "capture", "secs": 3},
                     {"scenario": "record", "format": "gif", "secs": True},
                     {"scenario": "record", "format": "gif", "secs": 9},
                     {"scenario": "pin", "script": "anything"}):
            with self.subTest(args=args), self.assertRaises(StepError):
                run_scenario(self.ctx, args)
        self.ctx.session.execute.assert_not_called()
