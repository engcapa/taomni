"""Pure authenticity/profile-oracle units; never downloads, installs or starts an app."""
from contextlib import closing
from dataclasses import replace
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from qa_ui_auto.legacy_release import ASSETS, selected_asset, verify_asset
from qa_ui_auto.legacy_process import sanitized_output
from qa_ui_auto.legacy_install import install
from qa_ui_auto.fixtures.module_legacy_install import insert_business_rows, retained_manifest, session_rows
from qa_ui_auto.fixtures.module_upgrade import input_sessions


class PinnedReleaseTests(unittest.TestCase):
    def test_only_explicit_supported_release_architectures_are_accepted(self):
        self.assertIs(selected_asset("Windows", "AMD64"), ASSETS[("Windows", "x64")])
        self.assertIs(selected_asset("Darwin", "aarch64"), ASSETS[("Darwin", "arm64")])
        self.assertIs(selected_asset("Darwin", "x86_64"), ASSETS[("Darwin", "x64")])
        for system, arch in [("Linux", "aarch64"), ("Windows", "arm64"), ("FreeBSD", "x86_64")]:
            with self.assertRaisesRegex(RuntimeError, "No pinned"):
                selected_asset(system, arch)

    def test_substituted_same_size_installer_and_partial_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "installer"
            path.write_bytes(b"trusted fixture")
            asset = replace(selected_asset("Linux", "x86_64"), size=15,
                            sha256=hashlib.sha256(b"trusted fixture").hexdigest())
            verify_asset(path, asset)
            path.write_bytes(b"changed fixture")
            with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                verify_asset(path, asset)
            path.write_bytes(b"partial")
            with self.assertRaisesRegex(RuntimeError, "wrong size"):
                verify_asset(path, asset)

    def test_local_or_wrong_repository_install_cannot_reach_a_downloader(self):
        for environment in [{}, {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "other/repo"}]:
            with patch.dict("os.environ", environment, clear=True), patch("qa_ui_auto.legacy_install.download_asset") as download:
                with self.assertRaisesRegex(RuntimeError, "GitHub runners"):
                    install(Path("unused"), Path("unused"))
                download.assert_not_called()

    def test_pairing_codes_are_removed_but_startup_failure_remains_readable(self):
        raw = "Mobile endpoint: http://127.0.0.1:1234\nPairing code (5 minutes): 123456\nHeadless: permission denied\n"
        result = sanitized_output(raw)
        self.assertNotIn("123456", result)
        self.assertIn("127.0.0.1:1234", result)
        self.assertIn("permission denied", result)


class OldProfileInputTests(unittest.TestCase):
    def test_missing_old_schema_is_rejected_instead_of_synthesized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with closing(sqlite3.connect(root / "taomni.db")) as db:
                db.execute("CREATE TABLE sessions (id TEXT)")
            with self.assertRaisesRegex(RuntimeError, "actual legacy tables"):
                insert_business_rows(root, input_sessions(True))
            with closing(sqlite3.connect(root / "taomni.db")) as db:
                tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            self.assertEqual(tables, ["sessions"])

    def test_original_rows_cannot_be_overwritten_as_fixture_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with closing(sqlite3.connect(root / "taomni.db")) as db, db:
                db.executescript("CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES ('existing');"
                                 "CREATE TABLE server_configs (id TEXT); CREATE TABLE rdp_certificate_pins (id TEXT);")
            with self.assertRaisesRegex(RuntimeError, "unexpectedly contains sessions"):
                insert_business_rows(root, input_sessions(True))
            self.assertEqual(session_rows(root), [{"id": "existing"}])

    def test_actual_chat_sidecars_are_hashed_without_copying_or_requiring_valid_sqlite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with self.assertRaisesRegex(RuntimeError, "did not create"):
                retained_manifest(root)
            (root / "lanchat.sqlite").write_bytes(b"opaque old store")
            (root / "lanchat.sqlite-wal").write_bytes(b"opaque old WAL")
            result = retained_manifest(root)
            self.assertEqual(set(result), {"lanchat.sqlite", "lanchat.sqlite-wal"})
            self.assertEqual(result["lanchat.sqlite-wal"], {
                "bytes": 14, "sha256": hashlib.sha256(b"opaque old WAL").hexdigest()})
            self.assertEqual(set(path.name for path in root.iterdir()), set(result))


if __name__ == "__main__":
    unittest.main()
