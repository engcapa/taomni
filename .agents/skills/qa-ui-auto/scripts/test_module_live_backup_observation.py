"""The live-host oracle must reject stale rows, wrong identity and sidecars."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile

from qa_ui_auto.behavior_contract import is_check
from qa_ui_auto.module_live_backup_observation import VALUES, check_archive, validate
from qa_ui_auto.steps import StepError

GENERATION = "a1234567-1234-1234-1234-123456789abc"


class LiveSnapshotObservationTests(unittest.TestCase):
    def archive(self, root, *, rows=None, generation=GENERATION, extra=False, bad_hash=False):
        source = root / "source.sqlite"
        with closing(sqlite3.connect(source)) as db, db:
            db.execute("CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT)")
            db.executemany("INSERT INTO entries(value) VALUES (?)", [(value,) for value in (VALUES if rows is None else rows)])
        prefix = "plugins/hello-plugin/data/"
        files = {prefix + "hello.sqlite": source.read_bytes(), "databases/vault.db": b"core vault fixture"}
        if extra:
            files[prefix + "hello.sqlite-wal"] = b"unexpected sidecar"
        dataset = {"slug": "hello-plugin", "dataSchemaVersion": 1, "requiresVault": False,
                   "profileGeneration": generation, "job": GENERATION,
                   "files": [{"path": "hello.sqlite", "kind": "sqlite"}]}
        entries = [{"path": name, "sha256": "a" * 64 if bad_hash else hashlib.sha256(data).hexdigest(),
                    "sizeBytes": len(data)} for name, data in files.items()]
        path = root / "live.taobak"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("manifest.json", json.dumps({"formatVersion": 2, "pluginDatasets": [dataset], "files": entries}))
            for name, data in files.items():
                archive.writestr(name, data)
        return path

    def test_exact_original_rows_are_required_even_when_manifest_hashes_are_consistent(self):
        for options in [{"rows": VALUES[:1]}, {"rows": []}, {"rows": list(reversed(VALUES))}, {"extra": True},
                        {"generation": "b1234567-1234-1234-1234-123456789abc"}, {"bad_hash": True}]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                with self.assertRaises(StepError):
                    check_archive(self.archive(root, **options), root, GENERATION, VALUES)

    def test_relative_work_directory_is_resolved_and_sqlite_is_closed(self):
        with tempfile.TemporaryDirectory(prefix=".qa-unit-live-", dir=Path.cwd()) as directory:
            root = Path(directory).resolve()
            result = check_archive(self.archive(root), Path(os.path.relpath(root)), GENERATION, VALUES)
            self.assertEqual(result["dataset"]["slug"], "hello-plugin")
            (root / "live-live.sqlite").unlink()

    def test_only_observations_count_as_assertions_and_yaml_cannot_choose_business_input(self):
        self.assertTrue(is_check({"module_live_backup_probe": {"phase": "first-archive"}}))
        self.assertFalse(is_check({"module_live_backup_probe": {"phase": "write-first"}}))
        for args in [{"phase": "write-first", "value": "arbitrary"}, {"phase": "first-archive", "path": "/tmp/other"},
                     {"phase": "anything"}, {}, None]:
            with self.subTest(args=args), self.assertRaises(StepError):
                validate(args)


if __name__ == "__main__":
    unittest.main()
