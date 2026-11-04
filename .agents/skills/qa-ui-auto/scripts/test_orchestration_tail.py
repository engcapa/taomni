"""Offline tail-prefix oracle contracts; no sockets, native app or real workers."""
from __future__ import annotations

import hashlib
import importlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from qa_ui_auto.fixtures import orchestration
from qa_ui_auto.fixtures.orchestration_tail import (
    capture_prefix, install_recovery_probe, verify_recovery_probe,
)


def digest(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


class TailPrefixOracleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.report = Path(self.temp.name).resolve()
        self.root = self.report / "data" / "orchestration"
        (self.root / "artifacts").mkdir(parents=True)
        self.fixture = self.report / "fixture"
        self.fixture.mkdir()
        self.ctx = SimpleNamespace(case_id="TC-ORCH-PARTIAL-006", report_root=self.report, values={
            "orchestration_data_root": str(self.root), "orchestration_fixture_root": str(self.fixture)})
        self.db = sqlite3.connect(self.root / "state.sqlite3")
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE runs(id TEXT,data TEXT);
            CREATE TABLE artifacts(id TEXT,run_id TEXT,hash TEXT,data TEXT);
            CREATE TABLE request_ledger(run_id TEXT,kind TEXT,state TEXT);
        """)
        self.artifacts = []
        for item in ("design", "contract"):
            text = f"candidate {item}\n"
            artifact = {"id": item + "-original", "itemId": item, "hash": digest(text), "content": text}
            (self.root / "artifacts" / artifact["id"]).write_bytes(text.encode())
            self.artifacts.append(artifact)
            self.db.execute("INSERT INTO artifacts VALUES(?,?,?,?)", (
                artifact["id"], "run-tail", artifact["hash"], json.dumps(artifact)))
        self.run = {"id": "run-tail", "revision": 9, "status": "running", "recoveryCount": 1,
                    "artifacts": self.artifacts}
        self.db.execute("INSERT INTO runs VALUES(?,?)", ("run-tail", json.dumps(self.run)))
        self.db.executemany("INSERT INTO request_ledger VALUES(?,?,?)", [
            ("run-tail", "main", "failed"), ("run-tail", "recovery", "sent")])
        self.db.commit()
        orchestration.load_server()
        self.modules = importlib.import_module("behavior")
        self.manifest = {"pack_id": "run-tail", "expected_ids": ["tests"]}
        self.body = self.request(self.manifest)

    def request(self, manifest):
        return {"model": "fixture-tail-partial", "messages": [{"role": "user", "content":
                "TAOMNI_PACK_MANIFEST=" + json.dumps(manifest) + "\nTAOMNI_RECOVERY=true"}]}

    def test_captures_real_prefix_before_dispatch_and_keeps_original_id_hash(self):
        def respond(*_args):
            self.assertTrue((self.fixture / "pre-recovery-prefix.json").is_file())
            self.assertEqual(len(self.ctx.orchestration_tail_prefix["artifacts"]), 2)
            return "response"
        application = SimpleNamespace(dispatch=Mock(side_effect=respond))
        install_recovery_probe(self.ctx, application)
        self.assertEqual(application.dispatch("POST", "/v1/messages", self.body), "response")
        prefix = self.ctx.orchestration_tail_prefix
        self.assertEqual(prefix["requested_ids"], ["tests"])
        self.assertEqual({item["id"] for item in prefix["artifacts"]}, {"design-original", "contract-original"})
        self.assertEqual(json.loads((self.fixture / "pre-recovery-prefix.json").read_text())["run_id"], "run-tail")
        final = {"run_id": "run-tail", "artifacts": prefix["artifacts"] + [
            {"id": "tests-new", "item_id": "tests", "hash": "new", "path": "new", "bytes": 3}]}
        self.assertEqual(verify_recovery_probe(self.ctx, [final]), prefix)
        final["artifacts"][0] = {**final["artifacts"][0], "id": "design-replacement"}
        with self.assertRaisesRegex(AssertionError, "identity/hash"):
            verify_recovery_probe(self.ctx, [final])

    def test_prefix_failure_is_a_bounded_error_and_cannot_be_a_passing_oracle(self):
        path = self.root / "artifacts" / "contract-original"
        path.write_text("tampered")
        downstream = Mock(return_value="must not reply successfully")
        application = SimpleNamespace(dispatch=downstream)
        install_recovery_probe(self.ctx, application)
        reply = application.dispatch("POST", "/v1/messages", self.body)
        self.assertEqual(reply.status, 422)
        self.assertTrue(self.ctx.orchestration_tail_probe_failed)
        downstream.assert_not_called()
        with self.assertRaisesRegex(AssertionError, "prefix proof"):
            verify_recovery_probe(self.ctx, [{"run_id": "run-tail"}])

    def test_missing_complete_tail_and_replayed_items_are_rejected(self):
        self.run["artifacts"] = self.artifacts[:1]
        self.db.execute("UPDATE runs SET data=?", (json.dumps(self.run),))
        self.db.commit()
        with self.assertRaisesRegex(AssertionError, "not saved before recovery"):
            capture_prefix(self.ctx, self.body, self.modules)
        with self.assertRaisesRegex(AssertionError, "only missing tests"):
            capture_prefix(self.ctx, self.request({**self.manifest, "expected_ids": ["contract", "tests"]}), self.modules)

    def test_main_must_fail_and_extra_recovery_request_is_never_silent(self):
        application = SimpleNamespace(dispatch=Mock(return_value="response"))
        install_recovery_probe(self.ctx, application)
        self.assertEqual(application.dispatch("POST", "/v1/messages", self.body), "response")
        self.assertEqual(application.dispatch("POST", "/v1/messages", self.body).status, 422)
        self.assertTrue(self.ctx.orchestration_tail_probe_failed)
        del self.ctx.orchestration_tail_prefix
        self.db.execute("UPDATE request_ledger SET state='completed' WHERE kind='main'")
        self.db.commit()
        with self.assertRaisesRegex(AssertionError, "failed main"):
            capture_prefix(self.ctx, self.body, self.modules)


if __name__ == "__main__":
    unittest.main()
