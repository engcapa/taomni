"""Pure tool contracts: never touch the real OS clipboard or launch a UI."""
import json
from pathlib import Path
import platform
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto import file_clipboard as tool
from qa_ui_auto import file_clipboard_native as native
from qa_ui_auto import system_file_paste as paste
from qa_ui_auto.behavior_contract import is_check, validate_contract
from qa_ui_auto.fixtures import workspace_file_clipboard as fixture
from qa_ui_auto.steps import StepError
from qa_ui_auto.testcase import load_case
from qa_ui_auto.workspace_drop_observation import host_snapshot

ROOT = Path(__file__).resolve().parents[4]


class FileClipboardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ctx = SimpleNamespace(case_dir=self.root / "case", cfg={"app": {"mode": "native"}}, values={},
                                   case_id="TC-unit", report_root=self.root, worker_id=0, restore_host_permissions=Mock())
        fixture.setup(self.ctx)
        self.source = Path(self.ctx.values["workspace_drop_source"])

    def test_fixture_reuses_drop_bytes_and_exact_initial_snapshot_without_touching_clipboard(self):
        manifest = json.loads(Path(self.ctx.values["workspace_drop_manifest"]).read_text())
        self.assertEqual(host_snapshot(Path(manifest["base"])), manifest["states"]["seeded"])
        self.assertTrue((self.source / "latest B.txt").is_file())
        self.assertTrue(Path(self.ctx.values["workspace_clipboard_external_file"]).is_dir())
        self.assertTrue(Path(self.ctx.values["workspace_clipboard_external_directory"]).is_dir())
        self.assertEqual(list(Path(self.ctx.values["workspace_clipboard_external_file"]).iterdir()), [])

    def test_uri_formats_preserve_spaces_unicode_percent_and_unc_and_refuse_nonfiles(self):
        raw = "file:///tmp/%E4%B8%AD%E6%96%87%20%23%25.txt\r\nfile://server/share/a%20b\r\n"
        self.assertEqual(native.parse_uris(raw), ["/tmp/中文 #%.txt", "//server/share/a b"])
        self.assertEqual(native.parse_uris("copy\n" + raw, gnome=True), ["/tmp/中文 #%.txt", "//server/share/a b"])
        for raw in ["https://example.invalid/file", "file:///tmp/f#fragment"]:
            with self.assertRaises(StepError): native.parse_uris(raw)
        with self.assertRaises(StepError): native.parse_uris("cut\nfile:///tmp/f", gnome=True)

    def test_native_seed_and_assert_use_independent_formats_and_retain_hashes(self):
        paths = [str(self.source / "中文 空格.txt")]
        observed = {"paths": paths, "formats": ["FileDrop"], "nativeFormat": "CF_HDROP"}
        with patch.object(native, "seed") as seed, patch.object(native, "read", return_value=observed):
            tool.native(self.ctx, {"action": "seed", "paths": paths})
            seed.assert_called_once_with(self.ctx, paths)
            tool.native(self.ctx, {"action": "assert", "paths": paths})
        records = [json.loads(line) for line in (self.ctx.case_dir / "file-clipboard-observations.jsonl").read_text().splitlines()]
        self.assertEqual(len(records), 2)
        self.assertTrue(all(record["passed"] and record["independentNativeOracle"] for record in records))
        self.assertIn(paths[0], records[0]["fileHashes"])

    def test_native_assert_accepts_windows_separator_and_drive_letter_spelling_without_rewriting_evidence(self):
        expected = [r"D:\QA\root1\中文 空格.txt"]
        observed = {"paths": ["d:/QA/root1/中文 空格.txt"], "formats": ["FileDrop"], "nativeFormat": "CF_HDROP"}
        with patch.object(tool.platform, "system", return_value="Windows"), \
                patch.object(tool, "scoped", return_value=expected), \
                patch.object(tool, "digests", return_value={expected[0]: {"sha256": "fixture-sha256"}}), \
                patch.object(native, "read", return_value=observed), \
                patch.object(tool.time, "monotonic", side_effect=[0, 6]):
            tool.native(self.ctx, {"action": "assert", "paths": expected})
        record = json.loads((self.ctx.case_dir / "file-clipboard-observations.jsonl").read_text())
        self.assertTrue(record["passed"])
        self.assertEqual(record["expectedPaths"], expected)
        self.assertEqual(record["observation"], observed)
        self.assertIn(expected[0], record["fileHashes"])

    def test_system_paste_accepts_windows_path_spelling_before_and_after_real_shell_action(self):
        expected_paths = [r"D:\QA\root1\中文 空格.txt"]
        before = {"paths": ["d:/QA/root1/中文 空格.txt"], "formats": ["FileDrop"]}
        after = {"paths": [r"d:\QA\root1\中文 空格.txt"], "formats": ["FileDrop"]}
        destination = Path(self.ctx.values["workspace_clipboard_external_file"])
        snapshot = paste.expected_snapshot([str(self.source / "中文 空格.txt")])
        with patch.object(paste.platform, "system", return_value="Windows"), \
                patch.object(paste, "scoped", return_value=expected_paths), \
                patch.object(native, "read", side_effect=[before, after]), \
                patch.object(paste, "expected_snapshot", return_value=snapshot), \
                patch.object(paste, "host_snapshot", return_value=snapshot), \
                patch("qa_ui_auto.host_clipboard._ps", return_value="dispatched") as action:
            paste.run(self.ctx, {"directory": str(destination), "paths": expected_paths})
        self.assertIn("InvokeVerb('paste')", action.call_args.args[0])
        record = json.loads((self.ctx.case_dir / "system-file-paste.jsonl").read_text())
        self.assertTrue(record["passed"])
        self.assertEqual(record["clipboardBefore"], before)
        self.assertEqual(record["clipboardAfter"], after)
        self.assertEqual(record["observed"], snapshot)

    def test_windows_spelling_comparison_preserves_exact_order_names_and_scope(self):
        expected = [r"D:\QA\one.txt", r"D:\QA\two.txt"]
        with patch.object(tool.platform, "system", return_value="Windows"):
            self.assertTrue(tool.paths_match(["d:/QA/one.txt", "D:/QA/two.txt"], expected, mode="native"))
            for actual in [expected[::-1], expected[:1], expected + expected[:1],
                           ["D:/QA/other.txt", expected[1]], ["D:/elsewhere/one.txt", expected[1]],
                           ["D:/QA/ONE.txt", expected[1]], ["D:/QA/one.txt ", expected[1]],
                           ["D:/QA/../QA/one.txt", expected[1]], None, "D:/QA/one.txt", [None]]:
                with self.subTest(actual=actual):
                    self.assertFalse(tool.paths_match(actual, expected, mode="native"))
            self.assertFalse(tool.paths_match(["d:/QA/one.txt", "D:/QA/two.txt"], expected, mode="browser"))
        for system in ["Linux", "Darwin"]:
            with self.subTest(system=system), patch.object(tool.platform, "system", return_value=system):
                self.assertFalse(tool.paths_match(["d:/QA/one.txt", "D:/QA/two.txt"], expected, mode="native"))
                self.assertFalse(tool.paths_match(["/tmp/name"], ["/tmp/name "], mode="native"))
                self.assertTrue(tool.paths_match(expected, expected, mode="native"))

    def test_system_paste_rejects_other_file_before_dispatching_a_file_manager(self):
        paths = [str(self.source / "中文 空格.txt")]
        with patch.object(native, "read", return_value={"paths": [str(self.source / "second file.txt")]}), \
                patch("qa_ui_auto.host_clipboard._ps") as action:
            with self.assertRaisesRegex(StepError, "not the requested file list"):
                paste.run(self.ctx, {"directory": self.ctx.values["workspace_clipboard_external_file"], "paths": paths})
            action.assert_not_called()
        record = json.loads((self.ctx.case_dir / "system-file-paste.jsonl").read_text())
        self.assertFalse(record["passed"])
        self.assertEqual(list(Path(self.ctx.values["workspace_clipboard_external_file"]).iterdir()), [])

    def test_browser_only_uses_explicit_memory_clipboard_stub_and_dry_run_has_no_os_access(self):
        self.ctx.page = Mock()
        path = "/preview/workspace-drop-import-unit/source/f.txt"
        self.ctx.page.evaluate.return_value = {"paths": [path], "nativeFormat": False}
        with patch.object(native, "seed") as seed, patch.object(native, "read") as read:
            tool.browser(self.ctx, {"action": "seed", "paths": [path]})
            self.assertIn("/src/stubs/fileClipboard.ts", self.ctx.page.evaluate.call_args.args[0])
            self.ctx.dry_run = True
            tool.native(self.ctx, {"action": "seed", "paths": ["/not/a/real/path"]})
            seed.assert_not_called(); read.assert_not_called()

    def test_unowned_paths_and_malformed_args_fail_before_any_platform_command(self):
        with patch.object(native, "seed") as seed:
            for args in [None, {"action": "seed"}, {"action": "read", "paths": []},
                         {"action": "seed", "paths": [str(self.root.parent)]}]:
                with self.subTest(args=args), self.assertRaises(StepError): tool.native(self.ctx, args)
            seed.assert_not_called()
        with self.assertRaises(StepError): tool.scoped(self.ctx, ["/personal/file"], "browser")

    def test_windows_reader_requires_filedrop_not_plain_text_and_uses_json_paths(self):
        with patch.object(native.platform, "system", return_value="Windows"), \
                patch.object(native.host, "_ps", return_value=json.dumps({"paths": ["C:/中文 file"], "formats": ["FileDrop"]})) as ps:
            observed = native.read()
        self.assertEqual(observed["nativeFormat"], "CF_HDROP")
        self.assertIn("GetFileDropList", ps.call_args.args[0])
        with patch.object(native.platform, "system", return_value="Windows"), \
                patch.object(native.host, "_ps", return_value='{"paths":[],"formats":["UnicodeText"]}'):
            with self.assertRaises(StepError): native.read()
            self.assertEqual(native.read(require_files=False)["paths"], [])

    def test_linux_requires_native_mime_and_checks_both_formats_without_product_reads(self):
        formats = ["text/uri-list", "x-special/gnome-copied-files"]
        data = {"text/uri-list": b"file:///tmp/a%20b\r\n", "x-special/gnome-copied-files": b"copy\nfile:///tmp/a%20b"}
        with patch.object(native.platform, "system", return_value="Linux"), \
                patch.object(native.host, "targets", return_value=formats), \
                patch.object(native.host, "_wayland_text", return_value=False), \
                patch.object(native.host, "_xclip_get", side_effect=data.__getitem__):
            self.assertEqual(native.read()["paths"], ["/tmp/a b"])
            data[formats[1]] = b"copy\nfile:///tmp/other"
            with self.assertRaisesRegex(StepError, "disagree"): native.read()

    def test_system_paste_dispatches_real_shell_verb_and_checks_bytes_not_paths_alone(self):
        paths = [str(self.source / "中文 空格.txt")]
        destination = Path(self.ctx.values["workspace_clipboard_external_file"])
        expected = paste.expected_snapshot(paths)
        with patch.object(paste.platform, "system", return_value="Windows"), \
                patch.object(native, "read", return_value={"paths": paths, "formats": ["FileDrop"]}), \
                patch("qa_ui_auto.host_clipboard._ps", return_value="dispatched") as action, \
                patch.object(paste, "host_snapshot", return_value=expected):
            paste.run(self.ctx, {"directory": str(destination), "paths": paths})
        self.assertIn("InvokeVerb('paste')", action.call_args.args[0])
        self.assertNotIn("Copy-Item", action.call_args.args[0])
        record = json.loads((self.ctx.case_dir / "system-file-paste.jsonl").read_text())
        self.assertTrue(record["passed"])
        self.assertEqual(record["observed"], expected)

    def test_file_manager_permission_failure_is_not_a_pass_or_copy_fallback(self):
        paths = [str(self.source / "中文 空格.txt")]
        with patch.object(paste.platform, "system", return_value="Darwin"), \
                patch.object(native, "read", return_value={"paths": paths}), \
                patch("qa_ui_auto.host_clipboard._run", side_effect=RuntimeError("Accessibility denied")):
            with self.assertRaisesRegex(RuntimeError, "Accessibility denied"):
                paste.run(self.ctx, {"directory": self.ctx.values["workspace_clipboard_external_file"], "paths": paths})
        record = json.loads((self.ctx.case_dir / "system-file-paste.jsonl").read_text())
        self.assertFalse(record["passed"])
        self.assertIn("Accessibility denied", record["error"])
        self.assertEqual(list(Path(self.ctx.values["workspace_clipboard_external_file"]).iterdir()), [])

    def test_macos_adapter_writes_eager_urls_and_reads_json_without_trimming_paths(self):
        paths = ["/tmp/ 中文 trailing "]
        result = {"paths": paths, "formats": ["public.file-url"]}
        with patch.object(native.platform, "system", return_value="Darwin"), \
                patch.object(native.host, "_jxa", return_value=json.dumps(result)) as jxa:
            native.seed(self.ctx, paths)
            seed_source = jxa.call_args.args[0]
            self.assertIn("NSPasteboardItem", seed_source)
            self.assertIn("setStringForType", seed_source)
            self.assertEqual(native.read()["paths"], paths)
            self.assertIn("JSON.stringify", jxa.call_args.args[0])

    def test_linux_owner_is_foreground_multiformat_and_has_cleanup_without_host_access(self):
        ready = self.ctx.case_dir / "file-clipboard-owner-ready.json"
        ready.write_text("{}")
        process = Mock()
        process.poll.return_value = None
        with patch.object(native.platform, "system", return_value="Linux"), \
                patch.object(native.subprocess, "Popen", return_value=process) as popen, \
                patch.object(Path, "unlink"), patch.object(Path, "exists", return_value=True):
            native.seed(self.ctx, [str(self.source / "中文 空格.txt")])
        self.assertIn("-I", popen.call_args.args[0])
        self.assertEqual(self.ctx._file_clipboard_process, process)
        self.ctx.restore_host_permissions()
        process.kill.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)
        source = (ROOT / ".agents/skills/qa-ui-auto/scripts/qa_ui_auto/file_clipboard_owner.py").read_text()
        self.assertIn("gtk_clipboard_set_with_data", source)
        self.assertIn('b"text/uri-list"', source)
        self.assertIn('b"x-special/gnome-copied-files"', source)

    def test_x11_manager_never_falls_back_on_wayland_and_restricts_config_to_owned_process(self):
        from qa_ui_auto import file_manager_x11 as manager
        import os
        with patch.dict(os.environ, {"DISPLAY": ":99", "GDK_BACKEND": "wayland"}), \
                patch.object(manager.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(StepError, "Wayland"):
                manager.paste(self.ctx, Path(self.ctx.values["workspace_clipboard_external_file"]))
            launch.assert_not_called()
        source = Path(manager.__file__).read_text()
        self.assertIn("dbus-run-session", source)
        self.assertIn("os.getpgid(pid) == process.pid", source)
        self.assertIn('"XDG_{name}_HOME"', source)
        self.assertNotIn("shutil.copy", source)
        self.assertIn('"ctrl+v"', source)

    def test_finder_dispatch_is_a_real_menu_action_and_never_a_duplicate_command(self):
        self.assertIn('click pasteItem', paste.FINDER)
        self.assertIn('menu item "Paste Item" of menu "Edit"', paste.FINDER)
        self.assertNotIn("duplicate", paste.FINDER)
        self.assertNotIn("do shell script", paste.FINDER)

    def test_new_cases_are_reviewed_and_prior_drag_cases_are_unchanged(self):
        import subprocess
        for case_id, mode in [("089", "browser"), ("090", "native")]:
            case = load_case(ROOT / f"qa-ui-auto-tests/cases/TC-WS-{case_id}-workspace-file-clipboard-{mode}.testcase.yaml")
            self.assertEqual(validate_contract({"steps": case.steps, "verification": case.verification}, require_review=True), [])
            self.assertEqual(case.modes, [mode])
        for path in (ROOT / "qa-ui-auto-tests/cases").glob("TC-WS-08[78]-*.testcase.yaml"):
            self.assertEqual(path.read_bytes(), subprocess.check_output(["git", "-C", str(ROOT), "show", "HEAD:" + path.relative_to(ROOT).as_posix()]))
        self.assertTrue(is_check({"file_clipboard": {"action": "assert", "paths": []}}))
        self.assertFalse(is_check({"file_clipboard": {"action": "seed", "paths": []}}))
        self.assertTrue(is_check({"system_file_paste": {}}))


if __name__ == "__main__":
    unittest.main()
