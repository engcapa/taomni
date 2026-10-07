import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from qa_ui_auto.fixtures.workspace_membership import setup, chat_history, seed_chat_db
from tauri_webdriver import native_isolation_env


class WorkspaceMembershipFixtureTests(unittest.TestCase):
    def test_chat_history_has_distinct_persisted_workspace_owners(self):
        threads, messages = chat_history()
        with closing(sqlite3.connect(":memory:")) as db:
            seed_chat_db(db, threads, messages)
            for scope in ("main", "remote"):
                rows = db.execute("SELECT m.content FROM ai_chat_messages m JOIN ai_chat_threads t ON t.id=m.thread_id WHERE t.workspace_id=? ORDER BY t.updated_at", (f"qa-workspace-{scope}",)).fetchall()
                self.assertEqual(rows, [(f"QA {scope} persisted reply 1",), (f"QA {scope} persisted reply 2",)])
            self.assertEqual(db.execute("SELECT count(*) FROM ai_chat_threads WHERE linked_session_id IS NOT NULL").fetchone()[0], 0)

    def test_refuses_native_profile_without_matching_isolation(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=folder, values={})
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(RuntimeError, 'isolation environment'):
                    setup(ctx)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_canonical_session_is_shared_by_reference_in_real_sqlite(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}, 'ssh': {
                'host': '127.0.0.1', 'port': 2222, 'user': 'fixture-user',
                'password': 'must-not-be-persisted',
            }}, report_root=root, values={}, case_id='TC-WS-NATIVE-001')
            with patch.dict(os.environ, native_isolation_env(root)):
                setup(ctx)
            db_path = Path(ctx.values['workspace_catalog_db'])
            self.assertTrue(db_path.is_relative_to(root))
            with closing(sqlite3.connect(db_path)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM sessions WHERE id='qa-shared-ssh'").fetchone()[0], 1)
                endpoint = db.execute("SELECT host,port,username,auth_method,options_json FROM sessions WHERE id='qa-shared-ssh'").fetchone()
                self.assertEqual(endpoint[:3], ('127.0.0.1', 2222, 'fixture-user'))
                self.assertEqual(json.loads(endpoint[3]), 'Password')
                self.assertNotIn('must-not-be-persisted', str(endpoint))
                self.assertEqual(db.execute("SELECT count(*) FROM workspace_memberships WHERE session_id='qa-shared-ssh'").fetchone()[0], 2)
                memberships = [json.loads(row[0]) for row in db.execute('SELECT record_json FROM workspace_memberships')]
                self.assertTrue(all('host' not in record and 'password' not in record for record in memberships))
                root_record = json.loads(db.execute("SELECT record_json FROM workspaces WHERE id='qa-workspace-main'").fetchone()[0])
            project = Path(root_record['roots'][0]['path'])
            self.assertTrue(project.is_relative_to(root))
            self.assertTrue((project / '.git').is_dir())
            self.assertIn('QA workspace preview', (project / 'README.md').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
