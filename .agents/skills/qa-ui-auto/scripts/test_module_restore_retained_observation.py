"""An uninstalled real-host restore checks its SQLite dataset and locator.

These local unit fixtures never launch an application or invoke production IPC.
The UI case must retain all lifecycle, relaunch and Vault/MFA checks on GitHub.
"""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

import yaml

from qa_ui_auto import module_restore_observation as observation
from qa_ui_auto.module_live_backup_observation import VALUES
from qa_ui_auto.steps import StepError

BEFORE = "a1234567-1234-1234-1234-123456789abc"
AFTER = "b1234567-1234-1234-1234-123456789abc"


class RetainedRestoreObservationTests(unittest.TestCase):
    def prepare(self, directory):
        root = Path(directory).resolve()
        work = root / "case"
        work.mkdir()
        profile = root / "profile"
        plugins = profile / "plugins"
        data = plugins / "hello-plugin/data/hello.sqlite"
        data.parent.mkdir(parents=True)
        with closing(sqlite3.connect(data)) as db, db:
            db.execute("CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT)")
            db.execute("INSERT INTO entries(value) VALUES (?)", (VALUES[0],))
        control = plugins / ".retained-data"
        control.mkdir()
        locator = control / "hello-plugin.json"
        locator.write_text(json.dumps({
            "formatVersion": 1, "slug": "hello-plugin", "dataSchemaVersion": 1,
            "files": [{"path": "hello.sqlite", "kind": "sqlite"}],
        }))
        pointer = plugins / "hello-plugin/active.json"
        pointer.write_text(json.dumps({"activeVersion": None, "previousVersion": "0.1.0"}))
        (profile / ".profile-state.json").write_text(json.dumps({"generation": AFTER}))
        (work / "official-module-fixture.json").write_text(json.dumps({"pluginRoot": str(plugins)}))
        archive = profile / "original.taobak"
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("plugins/hello-plugin/data/hello.sqlite", data.read_bytes())
        (work / "module-restore-state.json").write_text(json.dumps({
            "step": "ui-prepared", "generation": BEFORE, "registryState": "uninstalled",
            "archive": str(archive), "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "activePointerSha256": hashlib.sha256(pointer.read_bytes()).hexdigest(),
        }))
        ctx = SimpleNamespace(case_dir=work, values={}, session=SimpleNamespace(
            restore_relaunch_observation={"passed": True, "manual_launch": False}))
        record = {"state": "uninstalled", "dataRetained": True, "reason": None}
        return ctx, record, data, locator, archive

    def observe(self, ctx, record):
        with patch.object(observation, "record", return_value=record), \
             patch.object(observation, "writer_lease", return_value={"exists": True, "held": False}):
            return observation.run(ctx, {"phase": "ui-restored"})

    def test_real_sqlite_restore_does_not_require_an_unseeded_text_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx, record, data, locator, _ = self.prepare(directory)
            self.assertFalse((data.parent / "qa-retained.txt").exists())
            self.observe(ctx, record)
            state = json.loads((ctx.case_dir / "module-restore-state.json").read_text())
            self.assertEqual(state["restoredGeneration"], AFTER)
            self.assertEqual(state["step"], "restored")
            self.assertTrue(locator.is_file())

    def test_ui_case_uses_lifecycle_probe_and_real_database_restore_oracle(self):
        case = next(Path("qa-ui-auto-tests/cases").glob("TC-MODULES-035-*.testcase.yaml"))
        steps = yaml.safe_load(case.read_text(encoding="utf-8"))["steps"]
        relaunch = next(index for index, step in enumerate(steps) if "native_confirm_restore_relaunch" in step)
        signed = next(step["module_signed_probe"] for step in steps[relaunch + 1:] if "module_signed_probe" in step)
        restored = next(step["module_restore_probe"] for step in steps[relaunch + 1:] if "module_restore_probe" in step)
        self.assertEqual(signed, {"phase": "uninstalled"})
        self.assertEqual(restored, {"phase": "ui-restored"})
        self.assertFalse(any(step.get("module_signed_probe", {}).get("phase") == "seed-data" for step in steps))

    def test_false_retention_missing_or_forged_locator_fail_the_restore(self):
        for mutation in ("status", "absent", "owner", "schema", "inventory", "capabilities"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                ctx, record, _, locator, _ = self.prepare(directory)
                contents = json.loads(locator.read_text())
                if mutation == "status":
                    record["dataRetained"] = False
                elif mutation == "absent":
                    locator.unlink()
                elif mutation == "owner":
                    contents["slug"] = "other-plugin"
                elif mutation == "schema":
                    contents["dataSchemaVersion"] = 2
                elif mutation == "inventory":
                    contents["files"] = [{"path": "qa-retained.txt", "kind": "file"}]
                else:
                    contents["commands"] = ["execute"]
                if mutation not in {"status", "absent"}:
                    locator.write_text(json.dumps(contents))
                with self.assertRaises(StepError):
                    self.observe(ctx, record)

    def test_full_snapshot_bytes_and_original_archive_must_remain_exact(self):
        for mutation in ("database", "archive"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                ctx, record, data, _, archive = self.prepare(directory)
                target = data if mutation == "database" else archive
                target.write_bytes(target.read_bytes() + b"unexpected trailing bytes")
                # SQLite still returns the expected original business rows.
                self.assertEqual(observation.rows(data), VALUES[:1])
                with self.assertRaises(StepError):
                    self.observe(ctx, record)

    @unittest.skipIf(os.name == "nt", "A Windows symlink requires a separate filesystem privilege")
    def test_retained_locator_and_control_directory_cannot_be_links(self):
        for link_control in (False, True):
            with self.subTest(link_control=link_control), tempfile.TemporaryDirectory() as directory:
                ctx, record, _, locator, _ = self.prepare(directory)
                source = locator.parent if link_control else locator
                moved = source.with_name(source.name + ".moved")
                source.rename(moved)
                source.symlink_to(moved, target_is_directory=link_control)
                with self.assertRaises(StepError):
                    self.observe(ctx, record)


if __name__ == "__main__":
    unittest.main()
