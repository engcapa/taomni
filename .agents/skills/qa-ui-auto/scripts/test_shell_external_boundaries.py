from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, Mock, patch
import json
import sys

from qa_ui_auto.steps import StepError
from qa_ui_auto.steps.file_dialogs import choose_file, download_file
from qa_ui_auto.mysql_observation import assert_rows
from qa_ui_auto.native_processes import owned_apps, observe
from qa_ui_auto.control_coverage import _selectors_in_step
from qa_ui_auto.rdp_steps import _do_host_clipboard
from qa_ui_auto.native_steps import _do_assert_value
from qa_ui_auto.steps.assertions import step_assert_value


class InputValueContract(TestCase):
    def test_native_and_browser_observe_live_unicode_values_and_reject_ascii_preedit(self):
        ctx = SimpleNamespace(session=Mock(), dry_run=False, page=Mock())
        ctx.session.execute.return_value = "你好"
        args = {"selector": "#qa-input", "regex": r"[\u4e00-\u9fff]"}
        _do_assert_value(ctx, args)
        ctx.page.locator.return_value.first.input_value.return_value = "你好"
        step_assert_value(ctx, args)
        ctx.session.execute.return_value = "nihao"
        with self.assertRaises(StepError):
            _do_assert_value(ctx, {**args, "timeout_sec": .001})


class ClipboardObservationContract(TestCase):
    def test_capture_requires_identified_qa_text_and_compares_full_dynamic_payload(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory))
            payload = "Title: SHELL-clipboard\nType: code-workspace\nTab ID: random-instance"
            with patch("qa_ui_auto.rdp_steps.host_clipboard.get_text", return_value=payload) as read:
                _do_host_clipboard(ctx, {"action": "capture", "name": "strip", "contains": "SHELL-clipboard"})
                _do_host_clipboard(ctx, {"action": "assert", "same_as": "strip"})
                self.assertEqual(read.call_count, 2)
            with patch("qa_ui_auto.rdp_steps.host_clipboard.get_text", return_value=payload + "\nsecret"):
                with self.assertRaises(StepError):
                    _do_host_clipboard(ctx, {"action": "assert", "same_as": "strip", "timeout_sec": .001})
            for args in ({"action": "capture", "name": "private"}, {"action": "assert", "same_as": "unknown"}):
                with self.subTest(args=args), self.assertRaises(StepError):
                    _do_host_clipboard(ctx, args)


class FileDialogContract(TestCase):
    def test_file_selection_clicks_the_control_and_supplies_real_case_input(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "case"
            case.mkdir()
            path = case / "input.json"
            path.write_text("{}")
            ctx = MagicMock(dry_run=False, case_dir=case)
            chooser = Mock()
            ctx.page.expect_file_chooser.return_value.__enter__.return_value = SimpleNamespace(value=chooser)
            choose_file(ctx, {"trigger": "#import", "path": str(path)})
            ctx.page.locator.assert_called_once_with("#import")
            ctx.page.locator.return_value.click.assert_called_once()
            chooser.set_files.assert_called_once_with(str(path.resolve()))
            with self.assertRaisesRegex(StepError, "report root"):
                choose_file(ctx, {"trigger": "#import", "path": str(root.parent / "outside.json")})

    def test_download_requires_the_real_event_and_preserves_a_failed_download(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "case"
            case.mkdir()
            path = case / "export.json"
            ctx = MagicMock(dry_run=False, case_dir=case)
            download = Mock()
            download.failure.return_value = None
            download.save_as.side_effect = lambda target: Path(target).write_text('{"sessions":[]}')
            ctx.page.expect_download.return_value.__enter__.return_value = SimpleNamespace(value=download)
            download_file(ctx, {"trigger": "#export", "path": str(path)})
            self.assertEqual(json.loads(path.read_text()), {"sessions": []})
            download.failure.return_value = "cancelled"
            with self.assertRaisesRegex(StepError, "cancelled"):
                download_file(ctx, {"trigger": "#export", "path": str(path)})
            self.assertEqual(download.save_as.call_count, 1)
            self.assertEqual(_selectors_in_step("download_file", {"trigger": "#export", "path": "x"}), ["#export"])


class MysqlObservationContract(TestCase):
    def test_independent_transaction_is_read_only_and_keeps_success_failure_rows_without_credentials(self):
        with TemporaryDirectory() as directory:
            cfg = {"database": dict(host="127.0.0.1", port=3306, user="test", password="private-unit-value", database="qa")}
            connection = MagicMock()
            cursor = Mock()
            cursor.fetchall.return_value = ((1, "before"),)
            connection.cursor.return_value.__enter__.return_value = cursor
            module = SimpleNamespace(connect=Mock(return_value=connection))
            args = {"query": "SELECT id, value FROM shell_rows ORDER BY id", "equals": [[1, "before"]]}
            with patch.dict(sys.modules, {"pymysql": module}):
                assert_rows(cfg, args, Path(directory))
                self.assertEqual([c.args[0] for c in cursor.execute.call_args_list], ["SET TRANSACTION READ ONLY", args["query"]])
                with self.assertRaises(StepError):
                    assert_rows(cfg, {**args, "equals": [[1, "after"]]}, Path(directory))
            connection.rollback.assert_called()
            self.assertEqual(connection.close.call_count, 2)
            raw = (Path(directory) / "mysql-committed-rows.jsonl").read_text()
            self.assertNotIn("private-unit-value", raw)
            self.assertEqual([json.loads(line)["passed"] for line in raw.splitlines()], [True, False])

    def test_rejects_writes_multiple_statements_and_exporting_files_before_connecting(self):
        for query in ("UPDATE x SET v=1", "SELECT 1; DROP TABLE x", "SELECT 1 INTO OUTFILE '/tmp/x'", "SELECT 1 FOR UPDATE"):
            with self.subTest(query=query), self.assertRaisesRegex(StepError, "read-only SELECT"):
                assert_rows({}, {"query": query, "equals": []}, Path("unused"))


class NativeProcessContract(TestCase):
    def test_selects_only_the_exact_app_in_the_owned_driver_tree(self):
        app = Path("qa.exe").resolve()
        rows = [dict(pid=1, parent=0, executable="driver"), dict(pid=2, parent=1, executable="web-driver"),
                dict(pid=3, parent=2, executable=str(app)), dict(pid=4, parent=0, executable=str(app)),
                dict(pid=5, parent=3, executable="webview")]
        self.assertEqual([row["pid"] for row in owned_apps(rows, 1, app)], [3])
        self.assertEqual([row["pid"] for row in owned_apps(rows, 3, app)], [3])

    def test_exit_requires_a_previous_owned_pid_and_retains_the_os_result(self):
        with TemporaryDirectory() as directory:
            app = Path(directory) / "qa.exe"
            ctx = SimpleNamespace(case_dir=Path(directory), session=SimpleNamespace(_harness=SimpleNamespace(
                application=app, driver=SimpleNamespace(proc=SimpleNamespace(pid=1)))))
            with self.assertRaisesRegex(StepError, "before asserting exit"):
                observe(ctx, {"state": "exited"})
            with patch("qa_ui_auto.native_processes.snapshot", return_value=[dict(pid=2, parent=1, executable=str(app))]):
                observe(ctx, {"state": "running"})
            with patch("qa_ui_auto.native_processes.snapshot", return_value=[dict(pid=9, parent=0, executable=str(app))]):
                observe(ctx, {"state": "exited"})
            records = [json.loads(line) for line in (Path(directory) / "native-app-processes.jsonl").read_text().splitlines()]
            self.assertTrue(all(row["passed"] for row in records))
            self.assertEqual(records[0]["samples"][0]["apps"][0]["pid"], 2)
