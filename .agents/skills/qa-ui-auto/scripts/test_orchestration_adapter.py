"""Pure adapter contracts using synthetic SQLite/files and mocked HTTP receipts.

These tests never launch Taomni, a browser, a network server or a real harness.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from unittest.mock import Mock, patch

from qa_ui_auto.fixtures import orchestration, reset_db


def digest(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


class OrchestrationAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.report = Path(self.temp.name).resolve()
        self.case = self.report / "TC-ORCH-005"
        self.case.mkdir()
        self.root = self.report / "native-data" / "orchestration"
        self.root.mkdir(parents=True)
        self.fixture = self.case / "orchestration-fixture"
        self.fixture.mkdir()
        (self.report / "project").mkdir()
        self.ctx = SimpleNamespace(
            case_id="TC-ORCH-005", case_dir=self.case, report_root=self.report,
            cfg={"app": {"mode": "native"}},
            values={"orchestration_data_root": str(self.root), "orchestration_fixture_root": str(self.fixture),
                    "orchestration_project": str(self.report / "project")},
        )
        self.db = sqlite3.connect(self.root / "state.sqlite3")
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE runs(data TEXT);
            CREATE TABLE artifacts(id TEXT, run_id TEXT, hash TEXT, data TEXT);
            CREATE TABLE request_ledger(run_id TEXT, kind TEXT, state TEXT);
            CREATE TABLE attempts(run_id TEXT, state TEXT);
            CREATE TABLE events(run_id TEXT, sequence INTEGER, data TEXT);
        """)
        # The production query orders runs by created_at/rowid.
        self.db.execute("ALTER TABLE runs ADD COLUMN created_at INTEGER DEFAULT 1")
        (self.root / "artifacts").mkdir()
        self.events = []

    def seed(self, case_id="TC-ORCH-005"):
        self.ctx.case_id = case_id
        expectation = orchestration.API_CASES[case_id]
        runs = []
        for index, intent in enumerate(expectation["intents"]):
            name = "Updated shared defaults" if index else "Shared QA plan"
            run = {"id": f"run-{index}", "intent": intent, "status": "candidate" if expectation["requests"] else "planned",
                   "worktreePath": None, "sources": [{"path": "AGENTS.md", "content": "rules", "hash": digest("rules")}],
                   "projectPath": self.ctx.values["orchestration_project"],
                   "settingsSnapshot": {"revision": index + 1, "name": name, "planningResourceId": "api",
                                        "reviewResourceId": "api", "resources": [{"id": "api", "kind": "api",
                                        "protocol": expectation["requests"][0] if expectation["requests"] else "openai_chat"}]},
                   "artifacts": [], "events": [],
                   "error": None, "requestCount": len(expectation["requests"]),
                   "recoveryCount": 1 if len(expectation["requests"]) == 2 else 0}
            for item in expectation["items"]:
                artifact = {"id": f"{index}-{item}", "itemId": item, "content": f"candidate {item}",
                            "hash": digest(f"candidate {item}"), "status": "candidate"}
                (self.root / "artifacts" / artifact["id"]).write_bytes(artifact["content"].encode())
                run["artifacts"].append(artifact)
                self.db.execute("INSERT INTO artifacts VALUES(?,?,?,?)",
                                (artifact["id"], run["id"], artifact["hash"], json.dumps(artifact)))
                run["events"].append({"kind": "candidate_saved"})
            ledger = [("main", "failed"), ("recovery", "completed")] if run["recoveryCount"] else [("main", "completed")]
            for kind, state in ledger if expectation["requests"] else []:
                self.db.execute("INSERT INTO request_ledger VALUES(?,?,?)", (run["id"], kind, state))
                self.db.execute("INSERT INTO attempts VALUES(?,?)", (run["id"], state))
                run["events"].append({"kind": "request_sent"})
            for sequence, event in enumerate(run["events"], 1):
                self.db.execute("INSERT INTO events VALUES(?,?,?)", (run["id"], sequence, json.dumps(event)))
            self.db.execute("INSERT INTO runs(data,created_at) VALUES(?,?)", (json.dumps(run), index + 1))
            runs.append(run)
        self.db.commit()
        (self.root / "profiles.json").write_text(json.dumps({"name": runs[-1]["settingsSnapshot"]["name"]}))
        self.events = [{"route": protocol, "method": "POST", "status": 200, "streaming": True,
                        "request_sha256": digest(f"request-{index}"), "request_id": f"request-{index}",
                        "worker_digest": None, "tool_name": None,
                        "scenario": "partial" if index == 0 and len(expectation["requests"]) == 2 else "complete"}
                       for index, protocol in enumerate(expectation["requests"])]
        return runs

    def test_all_direct_protocols_and_shared_zero_call_case_have_independent_evidence(self):
        self.seed()
        result = orchestration._verify_native(self.ctx, self.events)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["requests"][0]["route"], "openai_chat")
        self.assertEqual(len(result["runs"][0]["artifacts"]), 3)
        for case_id in ("TC-ORCH-001", "TC-ORCH-003", "TC-ORCH-PARTIAL-002"):
            with self.subTest(case_id=case_id):
                self.db.executescript("DELETE FROM artifacts; DELETE FROM runs; DELETE FROM request_ledger; DELETE FROM attempts; DELETE FROM events;")
                self.seed(case_id)
                self.assertEqual(orchestration._verify_native(self.ctx, self.events)["status"], "passed")

    def test_tail_case_requires_pre_recovery_prefix_and_exact_preserved_identity(self):
        runs = self.seed("TC-ORCH-PARTIAL-006")
        with self.assertRaisesRegex(AssertionError, "prefix proof"):
            orchestration._verify_native(self.ctx, self.events)
        artifacts = [{"id": item["id"], "item_id": item["itemId"], "hash": item["hash"],
                      "path": str(self.root / "artifacts" / item["id"]), "bytes": len(item["content"].encode())}
                     for item in runs[0]["artifacts"] if item["itemId"] != "tests"]
        self.ctx.orchestration_tail_prefix = {"run_id": "run-0", "requested_ids": ["tests"], "artifacts": artifacts}
        evidence = orchestration._verify_native(self.ctx, self.events)
        self.assertEqual(len(evidence["pre_recovery_prefix"]["artifacts"]), 2)
        artifacts[0]["id"] = "unexpected-replacement"
        with self.assertRaisesRegex(AssertionError, "identity/hash"):
            orchestration._verify_native(self.ctx, self.events)

    def test_wrong_protocol_and_extra_request_are_not_native_passes(self):
        self.seed()
        for events in ([{**self.events[0], "route": "openai_responses"}], self.events * 2,
                       [{**self.events[0], "scenario": "http-error"}], [{**self.events[0], "streaming": False}]):
            with self.subTest(events=events), self.assertRaises(AssertionError):
                orchestration._verify_native(self.ctx, events)

    def test_changed_disk_candidate_or_ledger_cannot_be_hidden_by_the_renderer(self):
        runs = self.seed()
        file = self.root / "artifacts" / runs[0]["artifacts"][0]["id"]
        original = file.read_bytes()
        file.write_text("tampered")
        with self.assertRaisesRegex(AssertionError, "disk bytes"):
            orchestration._verify_native(self.ctx, self.events)
        file.write_bytes(original)
        self.db.execute("UPDATE request_ledger SET state='reserved'")
        self.db.commit()
        with self.assertRaisesRegex(AssertionError, "ledger"):
            orchestration._verify_native(self.ctx, self.events)

    def test_readonly_sqlite_never_creates_a_missing_database(self):
        self.db.close()
        (self.root / "state.sqlite3").unlink()
        with self.assertRaisesRegex(AssertionError, "not created"):
            orchestration._verify_native(self.ctx, [])
        self.assertFalse((self.root / "state.sqlite3").exists())

    def test_teardown_failure_records_evidence_and_always_stops_fixture(self):
        self.seed()
        running = SimpleNamespace(application=SimpleNamespace(events=[]), close=Mock())
        self.ctx.orchestration_fixture = running
        with self.assertRaises(AssertionError):
            orchestration.teardown(self.ctx)
        running.close.assert_called_once()
        self.assertIsNone(self.ctx.orchestration_fixture)
        evidence = json.loads((self.fixture / "evidence.json").read_text())
        self.assertEqual(evidence["status"], "failed")

    def test_windows_extended_drive_and_unc_project_spellings_use_samefile_identity(self):
        pairs = (
            (r"\\?\D:\qa\source\project", r"D:\qa\source\project"),
            (r"\\?\UNC\fixture-host\share\project", r"\\fixture-host\share\project"),
        )
        for actual, expected in pairs:
            with self.subTest(actual=actual):
                self.assertNotEqual(PureWindowsPath(actual), PureWindowsPath(expected))
                actual_path = Mock()
                actual_path.samefile.return_value = True
                with patch.object(orchestration, "Path", return_value=actual_path) as path:
                    orchestration._verify_project_identity(actual, expected)
                path.assert_called_once_with(actual)
                actual_path.samefile.assert_called_once_with(expected)
                actual_path.resolve.assert_not_called()

    def test_different_or_missing_windows_project_identity_is_rejected(self):
        pairs = (
            (r"\\?\D:\qa\wrong-project", r"D:\qa\source\project"),
            (r"\\?\UNC\fixture-host\other\project", r"\\fixture-host\share\project"),
        )
        for actual, expected in pairs:
            with self.subTest(actual=actual):
                actual_path = Mock()
                actual_path.samefile.return_value = False
                with patch.object(orchestration, "Path", return_value=actual_path), \
                        self.assertRaisesRegex(AssertionError, "another project's source root"):
                    orchestration._verify_project_identity(actual, expected)
                actual_path.samefile.assert_called_once_with(expected)
        actual_path = Mock()
        actual_path.samefile.side_effect = FileNotFoundError("missing project")
        with patch.object(orchestration, "Path", return_value=actual_path), self.assertRaises(FileNotFoundError):
            orchestration._verify_project_identity(*pairs[0])

    def test_real_different_project_identity_still_fails_native_evidence(self):
        self.seed()
        other = self.report / "other-project"
        other.mkdir()
        self.ctx.values["orchestration_project"] = str(other)
        with self.assertRaisesRegex(AssertionError, "another project's source root"):
            orchestration._verify_native(self.ctx, self.events)

    def test_readonly_connection_closes_after_success_and_all_cursors_are_closed(self):
        self.seed()
        opened, cursors = [], []
        class RecordingConnection(sqlite3.Connection):
            def execute(connection, *args, **kwargs):
                cursor = super().execute(*args, **kwargs)
                cursors.append(cursor)
                return cursor
        connect = sqlite3.connect
        def record_connect(*args, **kwargs):
            connection = connect(*args, factory=RecordingConnection, **kwargs)
            opened.append(connection)
            return connection
        with patch.object(orchestration.sqlite3, "connect", side_effect=record_connect) as mocked:
            self.assertEqual(orchestration._verify_native(self.ctx, self.events)["status"], "passed")
        mocked.assert_called_once_with((self.root / "state.sqlite3").as_uri() + "?mode=ro", uri=True)
        self.assertTrue(cursors)
        for connection in opened:
            with self.assertRaises(sqlite3.ProgrammingError):
                connection.execute("SELECT 1")
        for cursor in cursors:
            with self.assertRaises(sqlite3.ProgrammingError):
                cursor.fetchone()

    def test_readonly_connection_closes_on_validation_and_query_exceptions(self):
        self.seed()
        connect = sqlite3.connect
        for cause in (AssertionError("different source"), OSError("identity unavailable")):
            with self.subTest(cause=type(cause).__name__):
                connection = connect((self.root / "state.sqlite3").as_uri() + "?mode=ro", uri=True)
                with patch.object(orchestration.sqlite3, "connect", return_value=connection), \
                        patch.object(orchestration, "_verify_project_identity", side_effect=cause), \
                        self.assertRaises(type(cause)):
                    orchestration._verify_native(self.ctx, self.events)
                with self.assertRaises(sqlite3.ProgrammingError):
                    connection.execute("SELECT 1")
        class BrokenQueryConnection(sqlite3.Connection):
            def execute(connection, *args, **kwargs):
                raise sqlite3.OperationalError("unreadable evidence query")
        broken = connect((self.root / "state.sqlite3").as_uri() + "?mode=ro", uri=True,
                         factory=BrokenQueryConnection)
        with patch.object(orchestration.sqlite3, "connect", return_value=broken), \
                self.assertRaises(sqlite3.OperationalError):
            orchestration._verify_native(self.ctx, self.events)
        with self.assertRaises(sqlite3.ProgrammingError):
            sqlite3.Connection.execute(broken, "SELECT 1")

    def test_query_cursor_closes_even_if_fetching_rows_fails(self):
        cursor = Mock()
        cursor.fetchall.side_effect = sqlite3.OperationalError("fetch failed")
        connection = Mock()
        connection.execute.return_value = cursor
        with self.assertRaises(sqlite3.OperationalError):
            orchestration._query_rows(connection, "SELECT data FROM runs", ())
        cursor.close.assert_called_once()

    def test_browser_setup_does_not_start_a_real_server_and_uses_case_parent_boundary(self):
        case = self.report / "browser-case"
        case.mkdir()
        ctx = SimpleNamespace(case_id="TC-ORCH-003", case_dir=case, cfg={"app": {"mode": "browser"}}, values={})
        def seed(context, root, _url):
            (root / "evidence.json").write_text(json.dumps({"scope": "browser_stub_only"}))
        with patch.object(orchestration, "load_server") as load, \
                patch.object(orchestration, "_seed_isolated_configuration", side_effect=seed):
            orchestration.setup(ctx)
        load.assert_not_called()
        self.assertIsNone(ctx.orchestration_fixture)
        self.assertEqual(ctx.values["orchestration_base_url"], "http://127.0.0.1:9/v1")
        orchestration.teardown(ctx)

    def test_reset_removes_previous_project_selection_without_resetting_it_on_reload(self):
        self.assertIn("taomni.orchestration.project.v1", reset_db.LOCAL_STORAGE_KEYS)
        self.assertIn("taomni.orchestration.selection.v1", reset_db.LOCAL_STORAGE_KEYS)
        page = Mock()
        reset_db._reset_browser(SimpleNamespace(page=page))
        script = page.evaluate.call_args.args[0]
        self.assertIn("qa-ui-auto.reset-complete", script)
        self.assertIn("taomni.orchestration.selection.v1", script)


if __name__ == "__main__":
    unittest.main()
