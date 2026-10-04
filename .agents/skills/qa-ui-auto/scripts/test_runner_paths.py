"""Relative report roots must export absolute, reusable fixture paths."""
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from qa_ui_auto import runner
from qa_ui_auto.fixtures import Fixture
from qa_ui_auto.steps import StepError


class RunnerPathsTest(TestCase):
    def fixture(self, expected_root):
        def setup(ctx):
            self.assertTrue(ctx.case_dir.is_absolute())
            self.assertEqual(ctx.case_dir.parent, expected_root)
            target = ctx.case_dir / "export.json"
            target.write_text('{"format":"taomni.sessions"}', encoding="utf-8")
            ctx.values["export"] = target.as_posix()
        return Fixture("export", setup, lambda ctx: None)

    def test_browser_fixture_export_is_read_once_without_repeating_relative_report_root(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            relative = Path(os.path.relpath(root))
            context = MagicMock()
            case = dict(id="TC-PATH", title="paths", fixtures=["export"],
                        steps=[{"assert_json_file": {"path": "${fixture.export}", "expect": {"format": "taomni.sessions"}}}])
            with patch.object(runner, "_browser_context", return_value=context), \
                 patch.object(runner, "get_fixture", return_value=self.fixture(root)):
                result = runner._run_browser_case_inner(dict(case=case, cfg={"app": {"base_url": "http://unused"}},
                    env={}, report_root=str(relative), worker_id=0))
            self.assertEqual(result["status"], "passed", result["failure"])
            self.assertTrue((root / "TC-PATH/export.json").is_file())

    def test_browser_failure_trace_still_has_a_report_relative_link(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            context = MagicMock()
            case = dict(id="TC-PATH", title="paths", fixtures=[], steps=[{"wait_for": "#absent"}])
            with patch.object(runner, "_browser_context", return_value=context), \
                 patch.dict(runner.STEP_REGISTRY, {"wait_for": MagicMock(side_effect=StepError("absent"))}):
                result = runner._run_browser_case_inner(dict(case=case, cfg={"app": {"base_url": "http://unused"}},
                    env={}, report_root=os.path.relpath(root), worker_id=0))
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["failure"]["artifacts"]["trace"], str(Path("TC-PATH/trace.zip")))

    def test_native_fixture_paths_and_harness_use_the_same_absolute_root(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            case = SimpleNamespace(id="TC-PATH", title="paths", tags=[], covers=[], modes=["native"],
                native_platforms=[], fixtures=["export"], timeout_sec=60, skip=None,
                steps=[{"assert_json_file": {"path": "${fixture.export}", "expect": {"format": "taomni.sessions"}}}])
            harness = MagicMock()
            harness.__enter__.return_value = harness
            harness.create_session.return_value.console_entries.return_value = []
            with patch("tauri_webdriver.NativeHarness", return_value=harness) as constructor, \
                 patch.object(runner.platform, "system", return_value="Linux"), \
                 patch.object(runner, "get_fixture", return_value=self.fixture(root)), \
                 patch.object(runner, "_jdtls_pids", return_value=set()), \
                 patch.object(runner, "_matching_pids", return_value=set()), \
                 patch.object(runner, "_reap_orphaned_jdtls", return_value={}), \
                 patch.object(runner, "_reap_lingering_qa_apps", return_value={}), \
                 patch("qa_ui_auto.native_diagnostics.collect"):
                result = runner._native_run([case], {"app": {"mode": "native"}}, {},
                    Path(os.path.relpath(root)), False)[0]
            self.assertEqual(result["status"], "passed", result["failure"])
            self.assertEqual(constructor.call_args.args[1], root)
