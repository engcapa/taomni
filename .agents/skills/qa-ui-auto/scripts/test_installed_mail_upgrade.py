"""Unit checks for the Linux installed Mail upgrade receipt."""

from contextlib import closing
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
import zipfile

from installed_mail_upgrade import (
    ACCOUNT_NAME, LEGACY_BODY, LEGACY_SUBJECT, MAIL_PLAN, NEW_SUBJECT,
    LegacyMailbox, account_stem, installed_package_identity, observe_staging,
)
from modular_bundle_inventory import digest
from qa_ui_auto.steps import StepError


class InstalledMailUpgradeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.profile = Path(temporary.name).resolve()
        self.account = "legacy@example.test"
        self.unique_uid = 11
        self.original = f"Subject: {LEGACY_SUBJECT}\r\n\r\n{LEGACY_BODY}\r\n".encode()
        self.original_sha = hashlib.sha256(self.original).hexdigest()
        self.fingerprint = "sha256:" + "ab" * 32 + ":bytes:32"
        self.stem = account_stem(self.account)
        self.source = self.profile / "mail-cache" / f"{self.stem}.db"
        self.module = self.profile / "plugins/mail"
        self.version = "0.1.49"
        self.version_path = self.module / "versions" / self.version

        with closing(sqlite3.connect(self.profile / "taomni.db")) as db, db:
            db.execute("CREATE TABLE sessions(id TEXT, session_type TEXT, name TEXT)")
            db.execute("INSERT INTO sessions VALUES (?, 'Mail', ?)", (self.account, ACCOUNT_NAME))
        self.create_cache(self.source)
        self.mailbox = LegacyMailbox.observe(self.profile)

    @staticmethod
    def write_json(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def write_original(self, database, content):
        original_path = database.with_suffix(".mail") / "objects" / self.original_sha[:2] / f"{self.original_sha}.eml.gz"
        original_path.parent.mkdir(parents=True, exist_ok=True)
        original_path.write_bytes(gzip.compress(content, mtime=0))

    def create_cache(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE mail_messages(account_id TEXT, folder TEXT, uid INTEGER, subject TEXT)")
            db.execute("CREATE TABLE mail_full_messages(account_id TEXT, folder TEXT, uid INTEGER, sha256 TEXT, raw_size INTEGER)")
            db.execute("INSERT INTO mail_messages VALUES (?, 'INBOX', ?, ?)", (self.account, self.unique_uid, LEGACY_SUBJECT))
            db.execute("INSERT INTO mail_full_messages VALUES (?, 'INBOX', ?, ?, ?)",
                       (self.account, self.unique_uid, self.original_sha, len(self.original)))
        self.write_original(path, self.original)

    def stage(self):
        proof = self.version_path / ".taomni-trust/package.taomni-plugin"
        proof.parent.mkdir(parents=True)
        assets = {"taomni-plugin-mail": b"native", "frontend/index.js": b"renderer"}
        with zipfile.ZipFile(proof, "w") as archive:
            for relative, contents in assets.items():
                archive.writestr(relative, contents)
                path = self.version_path / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(contents)
        package = {"version": self.version, "sha256": digest(proof)}
        plan = {"version": self.version, "archive_sha256": package["sha256"], "failed": False}
        self.write_json(self.profile / MAIL_PLAN, plan)
        return package, plan

    def commit_migration(self):
        self.create_cache(self.mailbox.module_db)
        self.mailbox.module_db.with_suffix(".imap-owner").write_text(f"taomni-imap-store-v1\n{self.stem}\n")
        self.write_json(self.mailbox.module_db.parent / ".legacy-mail-upgrade.json",
                        {"source_fingerprint": self.fingerprint})
        self.write_json(self.profile / "migration/journal.json", {"entries": [{
            "item": "mail-accounts", "state": "committed", "target": "plugins/mail/data",
            "source_path": "taomni.db", "source_fingerprint": self.fingerprint,
        }]})

    def test_legacy_observation_rejects_source_edits_and_corrupt_originals(self):
        self.assertEqual(self.mailbox.evidence()["originalSha256"], self.original_sha)
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("INSERT INTO mail_messages VALUES (?, 'INBOX', 12, ?)", (self.account, NEW_SUBJECT))
        with self.assertRaisesRegex(RuntimeError, "altered the legacy"):
            self.mailbox.assert_retained()
        self.write_original(self.source, self.original[:-4] + b"oops")
        with self.assertRaisesRegex(RuntimeError, "does not match the indexed content"):
            LegacyMailbox.observe(self.profile)

    def test_staging_accepts_only_verified_bytes_with_no_active_version_or_data(self):
        package, plan = self.stage()
        self.assertEqual(observe_staging(self.mailbox, package), plan)
        with self.assertRaisesRegex(RuntimeError, "matching signed catalog package"):
            observe_staging(self.mailbox, {**package, "version": "0.2.0"})
        self.write_json(self.module / "active.json", {"activeVersion": self.version})
        with self.assertRaisesRegex(RuntimeError, "before the expected restart"):
            observe_staging(self.mailbox, package)
        (self.module / "active.json").unlink()
        (self.version_path / ".taomni-trust/package.taomni-plugin").write_bytes(b"different archive")
        with self.assertRaisesRegex(RuntimeError, "proof does not match"):
            observe_staging(self.mailbox, package)

    def test_migration_checks_restart_journal_and_installed_entries(self):
        package, _ = self.stage()
        self.commit_migration()
        with self.assertRaisesRegex(RuntimeError, "regular restart"):
            self.mailbox.assert_migrated()
        (self.profile / MAIL_PLAN).unlink()
        self.assertEqual(self.mailbox.assert_migrated()["originalSha256"], self.original_sha)
        self.write_json(self.module / "active.json", {"activeVersion": self.version})
        identity = installed_package_identity(self.profile, package)
        self.assertEqual(identity["hostSha256"], hashlib.sha256(b"native").hexdigest())
        (self.version_path / "frontend/index.js").write_bytes(b"different code")
        with self.assertRaisesRegex(RuntimeError, "frontend/index.js differs"):
            installed_package_identity(self.profile, package)
        self.write_json(self.mailbox.module_db.parent / ".legacy-mail-upgrade.json", {"source_fingerprint": "wrong"})
        with self.assertRaisesRegex(RuntimeError, "migration journal"):
            self.mailbox.assert_migrated()

    def test_uninstall_requires_removed_executables_and_retained_new_data(self):
        self.commit_migration()
        self.write_json(self.module / "active.json", {
            "activeVersion": None, "previousVersion": self.version, "uninstalled": {"name": "Mail"},
        })
        self.version_path.mkdir(parents=True)
        with self.assertRaisesRegex(StepError, "left executable versions"):
            self.mailbox.assert_uninstalled(self.version, 12)
        shutil.rmtree(self.module / "versions")
        with self.assertRaisesRegex(RuntimeError, "Expected one cached"):
            self.mailbox.assert_uninstalled(self.version, 12)
        with closing(sqlite3.connect(self.mailbox.module_db)) as db, db:
            db.execute("INSERT INTO mail_messages VALUES (?, 'INBOX', 12, ?)", (self.account, NEW_SUBJECT))
        receipt = self.mailbox.assert_uninstalled(self.version, 12)
        self.assertEqual(receipt["retainedSyncedUid"], 12)
        self.assertFalse(receipt["writerLease"]["held"])
