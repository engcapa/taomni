import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env
from qa_ui_auto.fixtures import tao_memory


class MemoryFixtureTests(unittest.TestCase):
    def context(self, root):
        return SimpleNamespace(cfg={"app": {"mode": "native"}}, report_root=root,
                               case_dir=root / "case", values={})

    def test_seeds_only_the_verified_native_profile_and_closes_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            ctx = self.context(root)
            isolated = native_isolation_env(root)
            with patch.dict(os.environ, isolated, clear=True):
                tao_memory.setup(ctx)
            db_path = Path(isolated.get("NEWMOB_DATA_DIR") or isolated["XDG_DATA_HOME"]) / QA_APP_ID / "taomni.db"
            with sqlite3.connect(db_path) as db:
                self.assertEqual(db.execute("SELECT kind FROM tao_memory_entries ORDER BY kind").fetchall(),
                                 [("memory",), ("skill",), ("soul",)])
            db.close()
            # Windows rejects this while the fixture still owns a SQLite handle.
            db_path.rename(db_path.with_suffix(".retained"))
            self.assertTrue(Path(ctx.values["tao_memory_export"]).is_relative_to(root))

    def test_refuses_mismatched_isolation_before_creating_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(RuntimeError):
                    tao_memory.setup(self.context(root))
            self.assertEqual(list(root.iterdir()), [])
