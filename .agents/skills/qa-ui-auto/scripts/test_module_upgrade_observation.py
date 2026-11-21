"""Fixture/oracle units use disposable SQLite files; no app or service starts."""
from contextlib import closing
import json
import hashlib
from pathlib import Path
import sqlite3
from types import SimpleNamespace
import tempfile
import unittest

from qa_ui_auto.fixtures import module_legacy_restore
from qa_ui_auto.fixtures.module_upgrade import (
    CHAT_FILES, CLIENT_ITEMS, PIN_ROWS, SERVER_ITEMS, SERVER_ROWS, client_sessions,
    input_sessions, preview_client_snapshot, preview_snapshot, preview_server_snapshot,
)
from qa_ui_auto.fixtures.session_config import seed_sessions
from qa_ui_auto.module_upgrade_observation import observe, run, wal_fingerprint
from qa_ui_auto.steps import StepError
from unittest.mock import patch


class UpgradeObservationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.state = {"root": self.root, "sessions": input_sessions(True), "journal": None}
        for name, content in CHAT_FILES.items():
            (self.root / name).write_bytes(content)
        with closing(sqlite3.connect(self.root / "taomni.db")) as db, db:
            db.execute("CREATE TABLE sessions (id TEXT, session_type TEXT, options_json TEXT)")
            db.executemany("INSERT INTO sessions VALUES (?, ?, ?)", [
                (row["id"], row["session_type"], row["options_json"]) for row in self.state["sessions"]])
        self.journal = {"status": "pending", "to_core_api_version": "1", "entries": [{
            "item": "vnc-sessions", "state": "pending", "source_path": "taomni.db", "target": "",
            "source_fingerprint": "sha256:" + "a" * 64 + ":bytes:4096"}]}

    def write_journal(self):
        path = self.root / "migration" / "journal.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(self.journal), encoding="utf-8")

    def test_staged_restore_uses_the_legacy_session_schema_and_rejects_unapplied_data(self):
        profile = self.root / "staged"
        profile.mkdir()
        ctx = SimpleNamespace(case_dir=self.root)
        sessions = input_sessions(False)
        with patch("qa_ui_auto.fixtures.session_config.isolated_data_root", return_value=profile):
            seed_sessions(ctx, sessions)
        session = sessions[0]
        module_legacy_restore.stage(ctx, profile, session)
        with self.assertRaisesRegex(RuntimeError, "did not clear restore_intent.json"):
            module_legacy_restore.observe(profile, session)
        (profile / "restore_intent.json").unlink()
        pending = profile / ".pending_restore"
        saved = pending / module_legacy_restore.ARCHIVE_PATH
        saved.rename(self.root / "restore-db")
        saved.parent.rmdir()
        pending.rmdir()
        with self.assertRaisesRegex(RuntimeError, "did not restore the original session"):
            module_legacy_restore.observe(profile, session)
        (self.root / "restore-db").replace(profile / "taomni.db")
        self.assertEqual(module_legacy_restore.observe(profile, session), {
            "sessionId": session["id"], "restoredName": session["name"],
        })

    def test_fixed_browser_model_is_explicitly_separate_from_native_evidence(self):
        self.assertEqual(preview_snapshot(False)["candidates"], [])
        self.assertEqual(preview_snapshot(True)["candidates"][0]["plugin_slug"], "vnc-client")
        self.assertEqual([row["session_type"] for row in input_sessions(False)], ["SSH"])
        for args in [{"phase": "write"}, {"phase": "pending", "path": "/user-data"}, None]:
            with self.assertRaisesRegex(StepError, "fixed registered phase"):
                run(None, args)
        with self.assertRaisesRegex(StepError, "registered native"):
            run(SimpleNamespace(case_id="TC-MODULES-026"), {"phase": "pending"})

    def test_preflight_is_read_only_and_a_journal_is_a_real_failure(self):
        self.assertTrue(observe(self.root, self.state, "preflight")["moduleDirectoriesAbsent"])
        self.write_journal()
        with self.assertRaisesRegex(StepError, "Read-only preflight wrote"):
            observe(self.root, self.state, "preflight")

    def test_mail_preflight_rejects_creation_of_unused_default_storage(self):
        self.state["expected_items"] = ["mail-accounts"]
        self.assertTrue(observe(self.root, self.state, "preflight")["unusedDefaultMailCacheAbsent"])
        (self.root / "mail-cache").mkdir()
        with self.assertRaisesRegex(StepError, "created default Mail storage"):
            observe(self.root, self.state, "preflight")

    def test_pending_and_repeat_preserve_exact_journal_without_duplicate_items(self):
        self.write_journal()
        observe(self.root, self.state, "pending")
        observe(self.root, self.state, "repeat")
        self.journal["entries"].append(dict(self.journal["entries"][0]))
        self.write_journal()
        with self.assertRaisesRegex(StepError, "exactly one"):
            observe(self.root, self.state, "repeat")

    def test_first_install_allows_mfa_while_preserving_the_pending_vnc_owner_and_journal(self):
        self.write_journal()
        original = observe(self.root, self.state, "pending")["journal"]
        (self.root / "plugins" / "mfa" / "versions" / "0.1.0").mkdir(parents=True)
        with self.assertRaisesRegex(StepError, "directory for mfa"):
            observe(self.root, self.state, "repeat")
        result = observe(self.root, self.state, "after-first-install")
        self.assertEqual(result["journal"], original)
        self.assertIn("vnc-client", result["checkedAbsentModuleDirectories"])
        (self.root / "plugins" / "vnc-client").mkdir()
        with self.assertRaisesRegex(StepError, "directory for vnc-client"):
            observe(self.root, self.state, "after-first-install")

    def test_false_completion_wrong_owner_and_changed_fingerprint_are_rejected(self):
        self.journal["status"] = "complete"
        self.write_journal()
        with self.assertRaisesRegex(StepError, "Expected a pending upgrade journal"):
            observe(self.root, self.state, "pending")
        self.journal["status"] = "pending"
        self.journal["entries"][0]["item"] = "rdp-vnc-sessions"
        self.write_journal()
        with self.assertRaisesRegex(StepError, "incorrect owner"):
            observe(self.root, self.state, "pending")
        self.journal["entries"][0]["item"] = "vnc-sessions"
        self.write_journal()
        observe(self.root, self.state, "pending")
        self.journal["entries"][0]["source_fingerprint"] = "sha256:" + "b" * 64 + ":bytes:4096"
        self.write_journal()
        with self.assertRaisesRegex(StepError, "idempotent"):
            observe(self.root, self.state, "repeat")

    def test_deleted_chat_changed_sessions_and_pseudo_activation_are_rejected(self):
        path = self.root / "lanchat.db"
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(StepError, "retained LanChat"):
            observe(self.root, self.state, "preflight")
        path.write_bytes(CHAT_FILES[path.name])
        with closing(sqlite3.connect(self.root / "taomni.db")) as db, db:
            db.execute("UPDATE sessions SET session_type = 'RDP' WHERE session_type = 'VNC'")
        with self.assertRaisesRegex(StepError, "original session"):
            observe(self.root, self.state, "preflight")
        with closing(sqlite3.connect(self.root / "taomni.db")) as db, db:
            db.execute("UPDATE sessions SET session_type = 'VNC' WHERE session_type = 'RDP'")
        (self.root / "plugins" / "vnc-client").mkdir(parents=True)
        with self.assertRaisesRegex(StepError, "module owner/code/data"):
            observe(self.root, self.state, "preflight")

    def test_installed_old_database_sidecars_and_complete_rows_are_preserved(self):
        self.state["retained"] = {name: {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
                                  for name, content in CHAT_FILES.items()}
        with closing(sqlite3.connect(self.root / "taomni.db")) as db:
            db.row_factory = sqlite3.Row
            self.state["full_sessions"] = [dict(row) for row in db.execute("SELECT * FROM sessions ORDER BY id")]
        observe(self.root, self.state, "preflight")
        (self.root / "lanchat.sqlite-wal").write_bytes(b"unexpected new writer")
        with self.assertRaisesRegex(StepError, "file set"):
            observe(self.root, self.state, "preflight")
        (self.root / "lanchat.sqlite-wal").unlink()
        with closing(sqlite3.connect(self.root / "taomni.db")) as db, db:
            db.execute("ALTER TABLE sessions ADD COLUMN extra TEXT")
        with self.assertRaisesRegex(StepError, "complete old-version"):
            observe(self.root, self.state, "preflight")

    def test_three_server_items_require_distinct_pending_owners_and_unchanged_config_bytes(self):
        self.assertEqual([row["plugin_slug"] for row in preview_server_snapshot()["candidates"]],
                         ["servers", "rdp-server", "vnc-server"])
        self.state.update(expected_items=SERVER_ITEMS, server_configs=SERVER_ROWS)
        with closing(sqlite3.connect(self.root / "taomni.db")) as db, db:
            db.execute("CREATE TABLE server_configs (server_type TEXT, config_json TEXT, updated_at INTEGER)")
            db.executemany("INSERT INTO server_configs VALUES (?, ?, ?)", SERVER_ROWS)
        self.journal["entries"] = [{**self.journal["entries"][0], "item": item} for item in SERVER_ITEMS]
        self.write_journal()
        observe(self.root, self.state, "pending")
        observe(self.root, self.state, "repeat")
        self.journal["entries"][1]["item"] = "server-configs"
        self.write_journal()
        with self.assertRaisesRegex(StepError, "incorrect owner"):
            observe(self.root, self.state, "repeat")
        with closing(sqlite3.connect(self.root / "taomni.db")) as db, db:
            db.execute("UPDATE server_configs SET config_json = '{}' WHERE server_type = 'rdp'")
        with self.assertRaisesRegex(StepError, "original server configurations"):
            observe(self.root, self.state, "preflight")

    def test_combined_rdp_sources_keep_every_pending_item_and_original_pin(self):
        self.assertEqual([row["plugin_slug"] for row in preview_client_snapshot()["candidates"]],
                         ["rdp-client", "vnc-client", "rdp-client"])
        self.assertEqual([row["session_type"] for row in client_sessions()], ["SSH", "VNC", "RDP"])
        self.state.update(expected_items=CLIENT_ITEMS, certificate_pins=PIN_ROWS)
        with closing(sqlite3.connect(self.root / "taomni.db")) as db, db:
            db.execute("CREATE TABLE rdp_certificate_pins (endpoint TEXT, fingerprint TEXT, updated_at INTEGER)")
            db.executemany("INSERT INTO rdp_certificate_pins VALUES (?, ?, ?)", PIN_ROWS)
        self.journal["entries"] = [{**self.journal["entries"][0], "item": item} for item in CLIENT_ITEMS]
        self.write_journal()
        observe(self.root, self.state, "pending")
        observe(self.root, self.state, "repeat")
        self.journal["entries"].pop()
        self.write_journal()
        with self.assertRaisesRegex(StepError, "exactly one"):
            observe(self.root, self.state, "repeat")
        with closing(sqlite3.connect(self.root / "taomni.db")) as db, db:
            db.execute("UPDATE rdp_certificate_pins SET fingerprint = ?", ["cd" * 32])
        with self.assertRaisesRegex(StepError, "original RDP certificate pins"):
            observe(self.root, self.state, "preflight")

    def test_wal_oracle_rejects_a_main_only_journal_for_committed_data(self):
        database = self.root / "taomni.db"
        connection = sqlite3.connect(database)
        self.addCleanup(connection.close)
        connection.execute("PRAGMA journal_mode=WAL").fetchall()
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        main_bytes = database.read_bytes()
        self.state["wal_main_sha256"] = hashlib.sha256(main_bytes).hexdigest()
        vnc = next(row for row in self.state["sessions"] if row["session_type"] == "VNC")
        vnc["options_json"] = json.dumps({"upgradeWal": "committed-v1"})
        connection.execute("UPDATE sessions SET options_json = ? WHERE session_type = 'VNC'", [vnc["options_json"]])
        connection.commit()
        self.assertEqual(database.read_bytes(), main_bytes)
        self.journal["entries"][0]["source_fingerprint"] = f"sha256:{self.state['wal_main_sha256']}:bytes:{len(main_bytes)}"
        self.write_journal()
        with self.assertRaisesRegex(StepError, "does not bind the committed WAL"):
            observe(self.root, self.state, "pending")
        fingerprint, evidence = wal_fingerprint(self.root, self.state)
        self.assertGreater(evidence["walBytes"], 32)
        self.journal["entries"][0]["source_fingerprint"] = fingerprint
        self.write_journal()
        self.assertEqual(observe(self.root, self.state, "pending")["walInput"], evidence)
        observe(self.root, self.state, "repeat")
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        with self.assertRaisesRegex(StepError, "missing or was checkpointed"):
            observe(self.root, self.state, "repeat")


if __name__ == "__main__":
    unittest.main()
