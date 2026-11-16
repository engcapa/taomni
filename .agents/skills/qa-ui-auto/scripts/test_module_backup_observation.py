"""Ensure the independent native archive oracle rejects plausible false passes."""
import hashlib
import json
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
import zipfile

from qa_ui_auto.module_backup_observation import BLOB, DATABASE, MARKER, PAYLOAD, check_archive, validate, wait_manual_job
from qa_ui_auto.steps import StepError

GENERATION = "018f6811-b7b1-7000-8000-000000000002"


class ModuleBackupObservationTests(unittest.TestCase):
    def artifact(self, root, *, extra=False, blob=PAYLOAD, marker=MARKER, generation=GENERATION):
        database = root / "fixture.sqlite"
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("CREATE TABLE qa_snapshot_marker(value TEXT)")
            db.execute("INSERT INTO qa_snapshot_marker VALUES (?)", (marker,))
        prefix = "plugins/hello-plugin/data/"
        files = {prefix + DATABASE: database.read_bytes(), prefix + BLOB: blob, "databases/vault.db": b"vault fixture"}
        if extra:
            files[prefix + DATABASE + "-wal"] = b"unwanted WAL"
        dataset = {"slug": "hello-plugin", "dataSchemaVersion": 1, "requiresVault": False,
                   "job": "018f6811-b7b1-7000-8000-000000000001", "profileGeneration": generation,
                   "files": [{"path": DATABASE, "kind": "sqlite"}, {"path": BLOB, "kind": "file"}]}
        manifest = {"formatVersion": 2, "pluginDatasets": [dataset], "files": [
            {"path": path, "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data)} for path, data in files.items()]}
        target = root / "backup.taobak"
        with zipfile.ZipFile(target, "w") as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            for name, data in files.items():
                archive.writestr(name, data)
        return target

    def test_valid_dataset_contains_actual_rows_and_original_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            result = check_archive(self.artifact(root), root, GENERATION)
            self.assertEqual(result["formatVersion"], 2)
            self.assertEqual(result["dataset"]["slug"], "hello-plugin")

    def test_native_relative_case_directory_is_resolved_before_opening_sqlite_uri(self):
        # GitHub Windows uses C: for TEMP and D: for checkout. Keep this
        # fixture on the checkout drive so it represents a relative case path.
        with tempfile.TemporaryDirectory(prefix=".qa-unit-module-", dir=Path.cwd()) as tmp:
            root = Path(tmp).resolve()
            relative = Path(os.path.relpath(root))
            self.assertFalse(relative.is_absolute())
            result = check_archive(self.artifact(root), relative, GENERATION)
            self.assertEqual(result["dataset"]["slug"], "hello-plugin")
            # The reader must close the connection, including on Windows.
            (root / "backup-module.sqlite").unlink()

    def test_sidecars_changed_bytes_wrong_generation_and_plausible_empty_db_fail(self):
        for options in [{"extra": True}, {"blob": b"changed"}, {"generation": "018f6811-b7b1-7000-8000-000000000003"}, {"marker": "different row"}]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                with self.assertRaises(StepError):
                    check_archive(self.artifact(root, **options), root, GENERATION)

    def test_yaml_cannot_choose_paths_commands_or_fixture_contents(self):
        self.assertEqual(validate({"phase": "disabled-archive"}), "disabled-archive")
        for args in [None, {}, {"phase": "arbitrary"}, {"phase": "seed", "path": "/vault.db"}, {"phase": "seed", "command": "backup_create"}]:
            with self.subTest(args=args), self.assertRaises(StepError):
                validate(args)

    def test_manual_job_waits_for_new_identity_and_terminal_completion(self):
        old = "018f6811-b7b1-7000-8000-000000000001"
        new = "018f6811-b7b1-7000-8000-000000000003"
        ctx = SimpleNamespace(session=Mock())
        ctx.session.execute.side_effect = [old, new, new]
        with patch("qa_ui_auto.module_backup_observation.read_journal", side_effect=[
            {"id": new, "phase": "running"}, {"id": new, "phase": "completed"}
        ]) as read, patch("qa_ui_auto.module_backup_observation.time.sleep"):
            job_id, job = wait_manual_job(ctx, Path("/isolated-profile"), {old})
        self.assertEqual(job_id, new)
        self.assertEqual(job["phase"], "completed")
        self.assertEqual(read.call_count, 2)
        self.assertTrue(all(call.args[0].name == new + ".json" for call in read.call_args_list))

    def test_old_job_cannot_satisfy_new_backup_assertion(self):
        old = "018f6811-b7b1-7000-8000-000000000001"
        ctx = SimpleNamespace(session=Mock())
        ctx.session.execute.return_value = old
        with patch("qa_ui_auto.module_backup_observation.time.monotonic", side_effect=[0, 0, 91]), \
             patch("qa_ui_auto.module_backup_observation.time.sleep"), \
             patch("qa_ui_auto.module_backup_observation.read_journal") as read:
            with self.assertRaisesRegex(StepError, "distinct completed"):
                wait_manual_job(ctx, Path("/isolated-profile"), {old})
        read.assert_not_called()

    def test_failed_or_cancelled_new_job_fails_without_waiting_for_another(self):
        job_id = "018f6811-b7b1-7000-8000-000000000001"
        for phase in ("failed", "cancelled"):
            ctx = SimpleNamespace(session=Mock())
            ctx.session.execute.return_value = job_id
            with self.subTest(phase=phase), \
                 patch("qa_ui_auto.module_backup_observation.read_journal", return_value={"id": job_id, "phase": phase}), \
                 patch("qa_ui_auto.module_backup_observation.time.sleep") as sleep:
                with self.assertRaisesRegex(StepError, phase):
                    wait_manual_job(ctx, Path("/isolated-profile"), set())
                sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
