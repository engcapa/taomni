from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env
from qa_ui_auto.fixtures import tao_history


class HistoryFixtureTests(unittest.TestCase):
    def context(self, root):
        return SimpleNamespace(cfg={"app": {"mode": "native"}}, report_root=root,
                               case_dir=root / "case", values={})

    def test_seeds_distinct_home_and_legacy_stores_only_in_the_owned_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            isolated = native_isolation_env(root)
            with patch.dict(os.environ, isolated, clear=True):
                tao_history.setup(self.context(root))
            db_path = Path(isolated.get("NEWMOB_DATA_DIR") or isolated["XDG_DATA_HOME"]) / QA_APP_ID / "taomni.db"
            with closing(sqlite3.connect(db_path)) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM ai_chat_threads").fetchone()[0], 3)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM ds_app_threads").fetchone()[0], 2)
                snapshot = json.loads(db.execute("SELECT snapshot FROM ds_app_threads WHERE id='qa-home-keep'").fetchone()[0])
                self.assertEqual(snapshot["messages"][0]["text"], "Retain this Home transcript")
                self.assertEqual(db.execute("SELECT thread_id FROM ai_chat_messages").fetchall(), [("qa-legacy-delete",)])
            db_path.rename(db_path.with_suffix(".retained"))

    def test_refuses_unisolated_storage_without_writing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(RuntimeError):
                    tao_history.setup(self.context(root))
            self.assertEqual(list(root.iterdir()), [])
