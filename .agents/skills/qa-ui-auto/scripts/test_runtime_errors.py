"""A recovered UI or warning must not conceal an actual renderer crash."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from qa_ui_auto.runtime_errors import assert_snapshot
from qa_ui_auto.steps import StepError, get
from qa_ui_auto.native_steps import VERBS


class RuntimeErrorsTest(TestCase):
    def test_uncaught_rejection_and_react_boundary_errors_fail_after_ui_recovers(self):
        errors = [
            {"kind": "uncaught-error", "args": ["Panel constraints not found for index 2"]},
            {"kind": "unhandled-rejection", "args": ["unhandledrejection", "component failed"]},
            {"level": "error", "args": ["[ui] React render failed", "layout crashed"]},
        ]
        for mode in ("browser", "native"):
            for error in errors:
                with self.subTest(mode=mode, error=error), TemporaryDirectory() as directory:
                    snapshot = {"installed": True, "entries": [error], "crash": None}
                    with self.assertRaises(StepError):
                        assert_snapshot(snapshot, Path(directory), mode)
                    raw = json.loads((Path(directory) / "runtime-errors.jsonl").read_text())
                    self.assertEqual(raw["snapshot"], snapshot)

    def test_browser_pageerror_is_a_failure_even_without_crash_screen(self):
        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(StepError, "index 2"):
                assert_snapshot({"installed": True, "entries": [
                    {"level": "error", "text": "pageerror: Panel constraints not found for index 2"},
                ]}, Path(directory), "browser")

    def test_crash_ui_and_missing_monitor_fail_closed(self):
        for snapshot in (None, {}, {"installed": True, "entries": None},
                         {"installed": True, "entries": ["invalid"]},
                         {"installed": True, "entries": [], "crash": "Taomni UI encountered an error"}):
            with self.subTest(snapshot=snapshot), TemporaryDirectory() as directory:
                with self.assertRaises(StepError):
                    assert_snapshot(snapshot, Path(directory), "native")
                self.assertTrue((Path(directory) / "runtime-errors.jsonl").is_file())

    def test_warnings_and_handled_service_errors_remain_diagnostic(self):
        with TemporaryDirectory() as directory:
            assert_snapshot({"installed": True, "entries": [
                {"level": "warn", "text": "optional service unavailable"},
                {"level": "error", "args": ["handled connection refused"]},
            ]}, Path(directory), "native")

    def test_dispatch_keeps_errors_across_checkpoints_and_rejects_invalid_arguments(self):
        with TemporaryDirectory() as directory:
            entries = []
            ctx = SimpleNamespace(case_dir=Path(directory), dry_run=False,
                                  case_state={"runtime_console": entries}, page=Mock(), session=Mock())
            ctx.page.evaluate.return_value = {"crash": None}
            ctx.session.execute.return_value = {"installed": True, "entries": entries, "crash": None}
            for verb in (get("assert_no_runtime_errors"), VERBS["assert_no_runtime_errors"]):
                verb(ctx, None)
                with self.assertRaises(StepError):
                    verb(ctx, {"ignore": "errors"})
            entries.append({"kind": "uncaught-error", "args": ["async layout failed"]})
            for verb in (get("assert_no_runtime_errors"), VERBS["assert_no_runtime_errors"]):
                for _ in range(2):
                    with self.assertRaisesRegex(StepError, "async layout failed"):
                        verb(ctx, None)
            self.assertEqual(len((Path(directory) / "runtime-errors.jsonl").read_text().splitlines()), 6)

    def test_native_transport_failure_cannot_return_an_empty_pass(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory), session=Mock())
            ctx.session.execute.side_effect = RuntimeError("renderer disconnected")
            with self.assertRaisesRegex(RuntimeError, "disconnected"):
                VERBS["assert_no_runtime_errors"](ctx, None)
