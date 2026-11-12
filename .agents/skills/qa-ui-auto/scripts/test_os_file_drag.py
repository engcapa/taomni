"""Runner contracts only: no browser, WebDriver, app, or OS input is launched."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

import jsonschema

from qa_ui_auto import os_file_drag as drag
from qa_ui_auto.steps import REGISTRY, StepContext, StepError
from qa_ui_auto.native_steps import VERBS, run_native_step
from qa_ui_auto.testcase import TESTCASE_SCHEMA_PATH


class OsFileDragTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)
        self.page = Mock()
        self.page.evaluate.return_value = {"ok": True, "synthetic": True}
        self.ctx = StepContext(self.page, "TC-unit", self.folder, {}, {})

    def entries(self):
        return [json.loads(line) for line in (self.folder / "os-file-drag.jsonl").read_text().splitlines()]

    def test_uri_list_encodes_unicode_spaces_hash_percent_and_windows_unc(self):
        args = drag.validate({"phase": "drop", "paths": ["/tmp/中文 space#%.txt", r"C:\外部 folder\file.txt", r"\\server\share\a b.txt"]})
        self.assertEqual(args["uriList"].split("\r\n"), [
            "file:///tmp/%E4%B8%AD%E6%96%87%20space%23%25.txt",
            "file:///C:/%E5%A4%96%E9%83%A8%20folder/file.txt",
            "file://server/share/a%20b.txt",
        ])
        self.assertEqual(args["paths"][0], "/tmp/中文 space#%.txt")

    def test_schema_and_runtime_reject_invalid_arguments(self):
        schema = json.loads(TESTCASE_SCHEMA_PATH.read_text())
        validator = jsonschema.Draft202012Validator({
            "$ref": "#/$defs/step/properties/os_file_drag", "$defs": schema["$defs"],
        })
        for args in [None, {}, {"phase": "wrong"}, {"phase": "drop"},
                     {"phase": "enter", "paths": []}, {"phase": "over", "paths": "bad"},
                     {"phase": "drop", "paths": [1]}, {"phase": "leave", "selector": ""},
                     {"phase": "leave", "unknown": True}]:
            with self.subTest(args=args):
                self.assertTrue(list(validator.iter_errors(args)))
                with self.assertRaises(StepError):
                    drag.validate(args)
        for path in ["relative/file", "https://example.invalid/file", "file:///tmp/file", "a\r\nb", "\x00bad"]:
            with self.subTest(path=path), self.assertRaises(StepError):
                drag.validate({"phase": "drop", "paths": [path]})
        for args in [{"phase": "over"}, {"phase": "leave"}, {"phase": "enter", "paths": ["/source"]}]:
            self.assertFalse(list(validator.iter_errors(args)))
            drag.validate(args)

    def test_browser_registration_uses_shared_script_and_preserves_synthetic_evidence(self):
        REGISTRY["os_file_drag"](self.ctx, {"selector": "#directory", "phase": "drop", "paths": ["/source file"]})
        script, request = self.page.evaluate.call_args.args
        self.assertEqual(script, drag.SCRIPT)
        self.assertEqual(request["uriList"], "file:///source%20file")
        self.assertEqual(request["mode"], "browser")
        self.assertEqual(request["selector"], "#directory")
        self.assertTrue(self.entries()[0]["synthetic"])
        self.assertFalse(self.entries()[0]["physicalOsGesture"])
        self.assertTrue(self.entries()[0]["delivered"])

    def test_browser_dry_run_validates_without_input_or_evidence(self):
        self.ctx.dry_run = True
        REGISTRY["os_file_drag"](self.ctx, {"phase": "drop", "paths": ["/source"]})
        self.page.evaluate.assert_not_called()
        self.assertFalse(list(self.folder.iterdir()))
        with self.assertRaises(StepError):
            REGISTRY["os_file_drag"](self.ctx, {"phase": "drop"})

    def test_native_registration_starts_once_and_polls_through_sync_bridge(self):
        session = Mock()
        result = {"ok": True, "synthetic": True, "eventName": "tauri://drag-drop"}
        session.execute.side_effect = [True, {"done": False}, {"done": True, "value": result}, True]
        ctx = SimpleNamespace(session=session, case_dir=self.folder)
        summary = run_native_step(ctx, "os_file_drag", {"selector": "#row", "phase": "drop", "paths": ["/source"]})
        scripts = [call.args[0] for call in session.execute.call_args_list]
        self.assertIn('"paths": ["/source"]', scripts[0])
        self.assertIn('"mode": "native"', scripts[0])
        self.assertIn("tauri.event.emitTo", scripts[0])
        self.assertNotIn("workspace_import_paths", scripts[0])
        self.assertEqual(sum("tauri.event.emitTo" in script for script in scripts), 1)
        self.assertTrue(scripts[1].startswith("return window["))
        self.assertTrue(scripts[-1].startswith("delete window["))
        session.request.assert_not_called()
        self.assertIn("not an OS gesture", summary)

    def test_native_uncertain_delivery_is_not_retried_and_slot_cleanup_is_attempted(self):
        session = Mock()
        session.execute.side_effect = [True, RuntimeError("transport failed"), True]
        ctx = SimpleNamespace(session=session, case_dir=self.folder)
        with self.assertRaisesRegex(RuntimeError, "transport failed"):
            drag.native(ctx, {"phase": "drop", "paths": ["/source"]})
        scripts = [call.args[0] for call in session.execute.call_args_list]
        self.assertEqual(sum("tauri.event.emitTo" in script for script in scripts), 1)
        self.assertTrue(scripts[-1].startswith("delete window["))
        self.assertFalse(self.entries()[-1]["delivered"])

    def test_delivery_errors_are_retained_and_never_retried(self):
        for result in [None, {"ok": False, "error": "occluded"}]:
            with self.subTest(result=result), self.assertRaises(StepError):
                self.page.evaluate.return_value = result
                drag.browser(self.ctx, {"phase": "leave"})
        self.page.evaluate.side_effect = RuntimeError("transport failed")
        with self.assertRaisesRegex(RuntimeError, "transport failed"):
            drag.browser(self.ctx, {"phase": "over"})
        self.assertEqual(self.page.evaluate.call_count, 3)
        self.assertTrue(all(not entry["delivered"] for entry in self.entries()))
        self.assertIn("transport failed", self.entries()[-1]["error"])

    def test_dom_and_tauri_script_unit_contracts_without_a_webview(self):
        # Existing hosted drag suites also exercise the exact JS with a small
        # Node VM DOM fake. No Playwright/WebDriver/browser process is created.
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node is required for synthetic event tool contracts")
        result = subprocess.run([node, "--test", str(Path(__file__).with_suffix(".mjs"))],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_extracted_native_extensions_keep_existing_public_registrations(self):
        for name in ["os_file_drag", "assert_workspace_drop_import", "terminal_rendering_probe",
                     "save_race_arm", "save_race_note", "assert_language_startup",
                     "native_sdk_startup_probe", "measure_workspace_file_open", "reveal_project_tree_row",
                     "mobile_service_probe", "parity005_native_fault"]:
            with self.subTest(name=name):
                self.assertTrue(callable(VERBS[name]))
        self.assertIs(VERBS["os_file_drag"], drag.native)


if __name__ == "__main__":
    unittest.main()
