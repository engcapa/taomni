"""Pure validation of the native transfer oracle; no sockets/processes here."""
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto.behavior_contract import is_check
from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env
from qa_ui_auto.fixtures.module_download import plugin_root, range_offset
from qa_ui_auto.module_download_observation import invoke, run
from qa_ui_auto.native_steps import NativeStepContext
from qa_ui_auto.steps import StepError


class ModuleDownloadObservationTests(unittest.TestCase):
    def test_real_native_step_context_uses_its_fixture_owned_isolation_root(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory).resolve()
            case = report / "TC-MODULES-021"
            fixture = SimpleNamespace(report_root=report, case_dir=case)
            step = NativeStepContext(Mock(), case, {}, fixture_context=fixture)
            isolation = native_isolation_env(report)
            with patch.dict(os.environ, isolation):
                expected = Path(isolation.get("NEWMOB_DATA_DIR") or isolation["XDG_DATA_HOME"]) / QA_APP_ID / "plugins"
                self.assertEqual(plugin_root(step), expected)
                self.assertEqual(plugin_root(fixture), expected)
                key = next(iter(isolation))
                with patch.dict(os.environ, {key: str(report / "wrong-owner")}):
                    with self.assertRaisesRegex(StepError, "verified isolated QA profile"):
                        plugin_root(step)

    def test_range_only_accepts_a_real_incomplete_prefix(self):
        self.assertEqual(range_offset(None, 100), 0)
        self.assertEqual(range_offset("bytes=16-", 100), 16)
        for value in ("bytes=0-", "bytes=100-", "bytes=16-25", "bytes=-4", "items=3-", "bytes=1-,2-"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                range_offset(value, 100)

    def test_yaml_cannot_choose_commands_paths_or_origin(self):
        for args in ({"phase": "start", "url": "http://other"}, {"phase": "custom"}, None):
            with self.subTest(args=args), self.assertRaises(StepError):
                run(Mock(), args)
        with self.assertRaises(StepError):
            invoke(Mock(), "plugin_network_save", {})

    def test_production_rejection_remains_a_failure_and_observation_slot_is_released(self):
        session = Mock()
        session.execute.side_effect = [True, {"observation": {"done": True, "error": "download root is invalid"}}, True]
        with self.assertRaisesRegex(StepError, "download root is invalid"):
            invoke(session, "plugin_download_start", {})
        self.assertTrue(session.execute.call_args.args[0].startswith("delete window["))

    def test_only_real_oracle_observations_count_as_results(self):
        for phase in ("cancelled", "recovered", "proxy-failed", "completed", "forgotten", "advance-background"):
            self.assertTrue(is_check({"module_download_probe": {"phase": phase}}))
        for phase in ("start", "finish"):
            self.assertFalse(is_check({"module_download_probe": {"phase": phase}}))


if __name__ == "__main__":
    unittest.main()
