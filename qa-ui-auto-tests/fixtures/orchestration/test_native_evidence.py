"""Offline tests for independent native scheduler evidence, no app/service/Git."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from receipts import validate_artifact, validate_worker_events

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / ".agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/orchestration_workers.py"


def load_helper():
    # Do not import the complete QA registry, native WebDriver or third-party
    # packages into these stdlib tests. The helper's package sibling is inert.
    package = types.ModuleType("native_evidence_unit")
    package.__path__ = []
    sibling = types.ModuleType("native_evidence_unit.orchestration")
    sibling.load_server = lambda: None
    with patch.dict(sys.modules, {"native_evidence_unit": package,
                                 "native_evidence_unit.orchestration": sibling}):
        spec = importlib.util.spec_from_file_location("native_evidence_unit.workers", HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class NativeEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.helper = load_helper()
        self.project = self.root / "project"
        self.project.mkdir()
        (self.root / "artifacts").mkdir()
        (self.root / "worker-state").mkdir()
        (self.root / "worktrees").mkdir()
        self.expected = {"run_id": "fixture-run", "project": self.project, "installation": {"harnesses": {}}}
        self.events = []
        connection = sqlite3.connect(self.root / "state.sqlite3")
        connection.executescript("""CREATE TABLE runs(id TEXT,status TEXT,data TEXT);
            CREATE TABLE tasks(id TEXT,run_id TEXT,status TEXT);
            CREATE TABLE request_ledger(run_id TEXT,kind TEXT,state TEXT);
            CREATE TABLE attempts(run_id TEXT,state TEXT,owner TEXT);
            CREATE TABLE artifacts(item_id TEXT,run_id TEXT,hash TEXT,data TEXT);""")
        for index, name in enumerate(self.helper.HARNESS_NAMES):
            run = f"native-{index}"
            worktree = self.root / "worktrees" / run
            worktree.mkdir()
            (worktree / "taomni-worker-marker.txt").write_text(f"taomni:fixture-run:{name}\n")
            (worktree / ".taomni-orchestration-owner").write_text(run)
            final = {"type": "worker_result", "status": "completed", "run_id": "fixture-run", "worker_id": name,
                     "artifact": "taomni-worker-marker.txt"}
            content = json.dumps(final)
            digest = hashlib.sha256(content.encode()).hexdigest()
            artifact = {"id": "artifact-" + run, "itemId": "implementation", "content": content, "hash": digest,
                        "format": "markdown", "status": "candidate", "name": "Worker candidate summary"}
            (self.root / "artifacts" / artifact["id"]).write_text(content)
            snapshot = {"worktreePath": str(worktree), "status": "candidate", "intent": "develop", "sourceRevision": "a" * 40,
                "requestCount": 1, "recoveryCount": 0, "error": None, "artifacts": [artifact],
                "settingsSnapshot": {"workerResourceIds": ["resource-" + name],
                    "resources": [{"id": "resource-" + name, "name": name}]}}
            connection.execute("INSERT INTO runs VALUES(?,?,?)", (run, "candidate", json.dumps(snapshot)))
            connection.execute("INSERT INTO tasks VALUES(?,?,?)", ("implementation", run, "candidate"))
            connection.execute("INSERT INTO request_ledger VALUES(?,?,?)", (run, "main", "completed"))
            connection.execute("INSERT INTO attempts VALUES(?,?,?)", (run, "completed", "native-owner"))
            connection.execute("INSERT INTO artifacts VALUES(?,?,?,?)", ("implementation", run, digest, json.dumps(artifact)))
            protocol = "anthropic_messages" if name in {"claude-code", "deepseek-harness"} else "openai_responses" if name == "codex" else "openai_chat"
            identity = {"entrypoint_sha256": "offline-pin-" + name}
            self.expected["installation"]["harnesses"][name] = {**identity, "protocol": protocol}
            process = {"harness": name, "exit_code": 0, "cwd": str(worktree), "pid": index + 100,
                       "identity": identity, "protocol": protocol, "matching_final_result": True,
                       "stdout_sha256": "offline-output", "event_types": ["result"]}
            state = self.root / "worker-state" / run
            state.mkdir()
            (state / "bridge-receipt.json").write_text(json.dumps({"is_error": False, "fixture_evidence": process}))
            base = {"worker_digest": hashlib.sha256(name.encode()).hexdigest(), "route": protocol, "status": 200,
                    "tool_call_id": "call-" + name, "request_sha256": "offline-hash"}
            self.events += [{**base, "scenario": "worker-tool", "tool_name": "bash", "request_id": "first-" + name},
                            {**base, "scenario": "worker-final", "tool_result_seen": True, "request_id": "second-" + name}]
        connection.commit()
        connection.close()

    def verify(self):
        def git(project, *args):
            if args[0] == "status":
                return b"" if project == self.project else b"?? .taomni-orchestration-owner\n?? taomni-worker-marker.txt\n"
            return ("a" * 40 + "\n").encode()
        with patch.object(self.helper, "git_output", side_effect=git):
            return self.helper.verify_database(self.root, self.expected, self.events, validate_artifact, validate_worker_events)

    def test_six_distinct_native_candidates_require_ledger_disk_process_wire_and_git_ownership(self):
        result = self.verify()
        self.assertEqual({row["harness"] for row in result}, set(self.helper.HARNESS_NAMES))
        self.assertEqual(len(result), 6)
        self.assertTrue(all(row["request_count"] == 1 and row["wire"]["generation_requests"] == 2 for row in result))

    def test_host_owner_marker_must_match_native_uuid_not_fixture_worker_identity(self):
        (self.root / "worktrees" / "native-0" / ".taomni-orchestration-owner").write_text("fixture-run")
        with self.assertRaises(AssertionError):
            self.verify()

    def test_missing_tool_return_cannot_be_replaced_by_successful_stdout(self):
        self.events[1]["tool_result_seen"] = False
        with self.assertRaises(AssertionError):
            self.verify()

    def test_artifact_database_success_is_not_enough_when_disk_content_changed(self):
        (self.root / "artifacts" / "artifact-native-0").write_text("forged candidate")
        with self.assertRaises(AssertionError):
            self.verify()

    def test_host_ledger_and_frozen_resource_ownership_cannot_be_missing(self):
        connection = sqlite3.connect(self.root / "state.sqlite3")
        connection.execute("DELETE FROM request_ledger WHERE run_id='native-0'")
        connection.commit()
        connection.close()
        with self.assertRaises(AssertionError):
            self.verify()

    def test_passing_marker_does_not_hide_wrong_installed_harness_identity(self):
        receipt = self.root / "worker-state" / "native-0" / "bridge-receipt.json"
        value = json.loads(receipt.read_text())
        value["fixture_evidence"]["identity"]["entrypoint_sha256"] = "wrong-binary"
        receipt.write_text(json.dumps(value))
        with self.assertRaises(AssertionError):
            self.verify()


if __name__ == "__main__":
    unittest.main()
