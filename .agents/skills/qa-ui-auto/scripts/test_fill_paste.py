"""Whole-source replacement must use real paste, preserve bytes and fail closed."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import jsonschema

from qa_ui_auto import host_clipboard
from qa_ui_auto.native_steps import _do_fill
from qa_ui_auto.steps import StepError
from qa_ui_auto.steps.keyboard import step_fill


SOURCE = "\n<!doctype html><h1>Created HTML 中文</h1>\n"
ARGS = {"selector": ".cm-content", "value": SOURCE, "method": "paste"}


class FillPasteTest(unittest.TestCase):
    def test_native_paste_orders_focus_selection_clipboard_and_os_input(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(session=Mock(), case_dir=Path(directory))
            calls = Mock()
            calls.attach_mock(ctx.session, "session")
            with patch.object(host_clipboard, "set_text") as write, \
                    patch.object(host_clipboard, "get_text", return_value=SOURCE) as read, \
                    patch("qa_ui_auto.native_paste.run") as paste:
                calls.attach_mock(write, "write")
                calls.attach_mock(read, "read")
                calls.attach_mock(paste, "paste")
                _do_fill(ctx, ARGS)
            self.assertEqual([c[0] for c in calls.mock_calls], [
                "session.focus", "session.press_combo", "write", "read", "paste"])
            ctx.session.press_combo.assert_called_once_with("Mod+a")
            write.assert_called_once_with(SOURCE)
            paste.assert_called_once_with(ctx, {"selector": ".cm-content"})
            record = json.loads((ctx.case_dir / "fill-paste.jsonl").read_text())
            self.assertTrue(record["passed"])
            self.assertTrue(record["clipboardRetained"])
            self.assertEqual(record["bytes"], len(SOURCE.encode("utf-8")))

    def test_native_clipboard_mismatch_never_pastes_or_falls_back(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(session=Mock(), case_dir=Path(directory))
            with patch.object(host_clipboard, "set_text"), \
                    patch.object(host_clipboard, "get_text", return_value=SOURCE.strip()), \
                    patch("qa_ui_auto.native_paste.run") as paste:
                with self.assertRaisesRegex(StepError, "read-back differs"):
                    _do_fill(ctx, ARGS)
            paste.assert_not_called()
            ctx.session.type_text.assert_not_called()
            ctx.session.fill.assert_not_called()
            record = json.loads((ctx.case_dir / "fill-paste.jsonl").read_text())
            self.assertFalse(record["passed"])

    def test_native_os_paste_failure_is_preserved_without_replay(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(session=Mock(), case_dir=Path(directory))
            with patch.object(host_clipboard, "set_text"), \
                    patch.object(host_clipboard, "get_text", return_value=SOURCE), \
                    patch("qa_ui_auto.native_paste.run", side_effect=StepError("OS input denied")) as paste:
                with self.assertRaisesRegex(StepError, "OS input denied"):
                    _do_fill(ctx, ARGS)
            paste.assert_called_once()
            ctx.session.fill.assert_not_called()
            self.assertFalse(json.loads((ctx.case_dir / "fill-paste.jsonl").read_text())["passed"])

    def test_browser_paste_uses_clipboard_roundtrip_then_key_input(self):
        ctx = SimpleNamespace(page=Mock(), dry_run=False)
        ctx.page.evaluate.return_value = SOURCE
        step_fill(ctx, ARGS)
        loc = ctx.page.locator.return_value.first
        loc.focus.assert_called_once_with()
        self.assertEqual([c.args[0] for c in loc.press.call_args_list], ["ControlOrMeta+a", "ControlOrMeta+v"])
        self.assertEqual(ctx.page.evaluate.call_args.args[1], SOURCE)
        loc.fill.assert_not_called()
        ctx.page.keyboard.insert_text.assert_not_called()

    def test_browser_clipboard_mismatch_never_pastes(self):
        ctx = SimpleNamespace(page=Mock(), dry_run=False)
        ctx.page.evaluate.return_value = SOURCE.strip()
        with self.assertRaisesRegex(StepError, "read-back differs"):
            step_fill(ctx, ARGS)
        ctx.page.locator.return_value.first.press.assert_called_once_with("ControlOrMeta+a")

    def test_windows_chromium_clipboard_uses_os_crlf_without_losing_source_whitespace(self):
        ctx = SimpleNamespace(page=Mock(), dry_run=False)
        ctx.page.evaluate.return_value = SOURCE.replace("\n", "\r\n")
        with patch("platform.system", return_value="Windows"):
            step_fill(ctx, ARGS)
        self.assertEqual(ctx.page.evaluate.call_args.args[1], SOURCE)
        self.assertEqual([c.args[0] for c in ctx.page.locator.return_value.first.press.call_args_list],
                         ["ControlOrMeta+a", "ControlOrMeta+v"])

    def test_other_platforms_do_not_accept_an_unexpected_clipboard_newline_change(self):
        for system in ["Linux", "Darwin"]:
            with self.subTest(system=system), patch("platform.system", return_value=system):
                ctx = SimpleNamespace(page=Mock(), dry_run=False)
                ctx.page.evaluate.return_value = SOURCE.replace("\n", "\r\n")
                with self.assertRaisesRegex(StepError, "read-back differs"):
                    step_fill(ctx, ARGS)
                ctx.page.locator.return_value.first.press.assert_called_once_with("ControlOrMeta+a")

    def test_dry_run_has_no_input_or_clipboard_side_effects(self):
        for execute in [step_fill, _do_fill]:
            with self.subTest(execute=execute.__name__):
                ctx = SimpleNamespace(page=Mock(), session=Mock(), dry_run=True)
                with patch.object(host_clipboard, "set_text") as write:
                    execute(ctx, ARGS)
                write.assert_not_called()
                self.assertEqual(ctx.page.mock_calls + ctx.session.mock_calls, [])

    def test_explicit_method_rejects_unknown_or_malformed_inputs(self):
        for execute in [step_fill, _do_fill]:
            for bad in [{"method": "typing"}, {"selector": ""}, {"value": ""}, {"value": 42}]:
                with self.subTest(execute=execute.__name__, bad=bad):
                    ctx = SimpleNamespace(page=Mock(), session=Mock(), dry_run=False)
                    with self.assertRaises(StepError):
                        execute(ctx, {**ARGS, **bad})
                    self.assertEqual(ctx.page.mock_calls + ctx.session.mock_calls, [])

    def test_default_native_fill_keeps_existing_input_transport(self):
        ctx = SimpleNamespace(session=Mock())
        _do_fill(ctx, {"selector": "input", "value": "ordinary"})
        ctx.session.fill.assert_called_once_with("input", "ordinary")

    def test_windows_independent_clipboard_read_preserves_all_whitespace(self):
        with patch.object(host_clipboard, "SYSTEM", "Windows"), \
                patch.object(host_clipboard, "_run", return_value=SOURCE.encode("utf-8")):
            self.assertEqual(host_clipboard.get_text(), SOURCE)

    def test_case_schema_allows_explicit_paste_and_rejects_invalid_method(self):
        schema = Path(__file__).resolve().parent.parent / "schema" / "testcase.schema.json"
        validator = jsonschema.Draft202012Validator(json.loads(schema.read_text()))
        for args, expected in [(ARGS, True), ({"selector": "input", "value": ""}, True),
                               ({**ARGS, "method": "typing"}, False), ({**ARGS, "value": ""}, False)]:
            with self.subTest(args=args):
                self.assertEqual(validator.is_valid({"id": "TC-X", "title": "x", "steps": [{"fill": args}]}), expected)


if __name__ == "__main__":
    unittest.main()
