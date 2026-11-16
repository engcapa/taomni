"""Contracts for read-only observations from the real native step context."""
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from qa_ui_auto.fixtures.backup_policy import isolated_data_root
from qa_ui_auto.native_steps import NativeStepContext
from qa_ui_auto.tao_real_handoff import persisted_handoff
from tauri_webdriver import native_isolation_env


class HandoffPersistenceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.case_dir = self.root / "TC-TAO-HOME-027"
        self.case_dir.mkdir()
        self.cfg = {"app": {"mode": "native"}}
        self.ctx = NativeStepContext(None, self.case_dir, self.cfg)
        environment = patch.dict(os.environ, native_isolation_env(self.root))
        environment.start()
        self.addCleanup(environment.stop)
        self.db_path = isolated_data_root(SimpleNamespace(cfg=self.cfg, report_root=self.root)) / "taomni.db"

    def test_reads_real_step_context_without_exposing_or_changing_text(self):
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.executescript("""
                CREATE TABLE ai_chat_threads(id TEXT, provider_id TEXT);
                CREATE TABLE ai_chat_messages(id TEXT, thread_id TEXT, role TEXT, content TEXT, created_at INTEGER);
                INSERT INTO ai_chat_threads VALUES('target','acp:qa-tao'),('unrelated','deepseek');
                INSERT INTO ai_chat_messages VALUES
                  ('u','target','user','private-synthetic-context',1),
                  ('a','target','assistant','QA coding agent result: private-synthetic-result',2),
                  ('other','unrelated','assistant','unrelated text',3);
            """)
        before = self.db_path.read_bytes()
        rows = persisted_handoff(self.ctx)
        self.assertEqual([row["role"] for row in rows], ["user", "assistant"])
        self.assertFalse(rows[0]["hasResult"])
        self.assertTrue(rows[1]["hasResult"])
        self.assertGreater(rows[1]["characters"], 0)
        self.assertNotIn("private-synthetic", json.dumps(rows))
        self.assertEqual(self.db_path.read_bytes(), before)

    def test_missing_database_is_not_created_by_observation(self):
        with self.assertRaises(sqlite3.OperationalError):
            persisted_handoff(self.ctx)
        self.assertFalse(self.db_path.exists())

    def test_different_isolation_environment_is_rejected(self):
        environment = native_isolation_env(self.root)
        data_key = next(key for key in ("NEWMOB_DATA_DIR", "XDG_DATA_HOME") if key in environment)
        with patch.dict(os.environ, {data_key: str(self.root / "other")}):
            with self.assertRaisesRegex(RuntimeError, "current run's isolation"):
                persisted_handoff(self.ctx)


if __name__ == "__main__":
    unittest.main()
