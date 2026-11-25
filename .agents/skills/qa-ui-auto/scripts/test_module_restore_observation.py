"""Restore evidence must distinguish staging, actual apply and ordinary restart."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from qa_ui_auto.behavior_contract import is_check
from qa_ui_auto.module_restore_observation import check_core_snapshots, check_generation, check_staging, stage, validate
from qa_ui_auto.native_steps import NativeStepContext
from qa_ui_auto.steps import StepError
from qa_ui_auto import module_restore_observation as observation

BEFORE = "a1234567-1234-1234-1234-123456789abc"
AFTER = "b1234567-1234-1234-1234-123456789abc"


class RestoreObservationTests(unittest.TestCase):
    def test_ui_selects_only_the_independently_verified_manual_backup_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            work = root / "case"
            work.mkdir()
            profile = root / "profile"
            profile.mkdir()
            plugins = profile / "plugins"
            plugins.mkdir()
            (profile / ".profile-state.json").write_text(json.dumps({"generation": BEFORE}))
            (work / "official-module-fixture.json").write_text(json.dumps({"pluginRoot": str(plugins)}))
            archive = self.paired_archive(profile, 0)
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            for mode in ("browser", "native"):
                with self.subTest(mode=mode):
                    (work / "module-restore-state.json").write_text(json.dumps({"generation": BEFORE, "step": "original"}))
                    fixture = SimpleNamespace(case_dir=work, values={"module_restore_job_id": "older-automatic-job"})
                    ctx = fixture if mode == "browser" else NativeStepContext(
                        SimpleNamespace(), work, {}, fixture_context=fixture)
                    with patch.object(observation, "record", return_value={"state": "disabled"}), \
                         patch.object(observation, "wait_manual_job", return_value=(AFTER, {"localPath": str(archive)})), \
                         patch.object(observation, "check_archive", return_value={"sha256": digest}), \
                         patch.object(observation, "writer_lease", return_value={"held": False}):
                        observation.run(ctx, {"phase": "disabled-archive"})
                    state = json.loads((work / "module-restore-state.json").read_text())
                    self.assertEqual(state["jobId"], AFTER)
                    self.assertEqual(state["archiveSha256"], digest)
                    self.assertEqual(fixture.values["module_restore_job_id"], AFTER)
            # The UI targets the exact checked job even if automatic backups
            # were inserted earlier/later in the same history list.
            for case in ("033", "034", "035"):
                path = next(Path("qa-ui-auto-tests/cases").glob(f"TC-MODULES-{case}-*.testcase.yaml"))
                import yaml
                steps = yaml.safe_load(path.read_text(encoding="utf-8"))["steps"]
                actions = [step["click"] for step in steps if isinstance(step.get("click"), str) and "backup-local-restore" in step["click"]]
                self.assertEqual(actions, ['[data-testid="backup-cloud-job"][data-job-id="${fixture.module_restore_job_id}"] [data-testid="backup-local-restore"]'])

    def test_apply_must_change_generation_and_ordinary_restart_must_keep_it(self):
        state = {"generation": BEFORE, "restoredGeneration": AFTER}
        check_generation(state, AFTER)
        check_generation(state, AFTER, persisted=True)
        for current, persisted in [(BEFORE, False), (BEFORE, True),
                                   ("c1234567-1234-1234-1234-123456789abc", True)]:
            with self.subTest(current=current, persisted=persisted), self.assertRaises(StepError):
                check_generation(state, current, persisted=persisted)

    def make_staging(self, root):
        payload = b"verified original bytes"
        manifest = {"files": [{"path": "plugins/hello-plugin/data/hello.sqlite", "sizeBytes": len(payload),
                               "sha256": hashlib.sha256(payload).hexdigest()}]}
        path = root / "original.taobak"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
        (root / ".profile-state.json").write_text(json.dumps({"generation": BEFORE}))
        (root / "restore_intent.json").write_text(json.dumps({"manifest": manifest}))
        staged = root / ".pending_restore" / manifest["files"][0]["path"]
        staged.parent.mkdir(parents=True)
        staged.write_bytes(payload)
        return path, staged, {"generation": BEFORE, "archiveSha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def test_staging_requires_exact_original_bytes_and_no_premature_apply(self):
        for mutation in ("bytes", "generation", "intent", "journal", "archive"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                path, staged, state = self.make_staging(root)
                check_staging(root, state, path)
                if mutation == "bytes":
                    staged.write_bytes(b"tampered original bytes")
                elif mutation == "generation":
                    (root / ".profile-state.json").write_text(json.dumps({"generation": AFTER}))
                elif mutation == "intent":
                    (root / "restore_intent.json").write_text(json.dumps({"manifest": {}}))
                elif mutation == "journal":
                    (root / "restore_journal.json").write_text("{}")
                else:
                    path.write_bytes(path.read_bytes() + b"changed")
                with self.assertRaises(StepError):
                    check_staging(root, state, path)

    def paired_archive(self, root, counter):
        path = root / "paired.taobak"
        with zipfile.ZipFile(path, "w") as archive:
            for name in ("mfa", "vault"):
                database = root / f"{name}.db"
                with closing(sqlite3.connect(database)) as db, db:
                    if name == "mfa":
                        db.execute("CREATE TABLE mfa_accounts(issuer, kind, counter, secret_ct)")
                        db.execute("INSERT INTO mfa_accounts VALUES ('QA Module Restore', 'hotp', ?, ?)", (counter, b"x" * 32))
                    else:
                        db.execute("CREATE TABLE vault_entries(id)")
                archive.writestr(f"databases/{name}.db", database.read_bytes())
        return path

    def test_paired_archive_requires_the_original_counter_and_closes_sqlite_handles(self):
        for counter in (0, 1):
            with self.subTest(counter=counter), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                path = self.paired_archive(root, counter)
                if counter == 0:
                    check_core_snapshots(path, root)
                    for name in ("mfa", "vault"):
                        (root / f"restore-original-{name}.sqlite").unlink()
                else:
                    with self.assertRaises(StepError):
                        check_core_snapshots(path, root)

    def test_staging_rejection_must_be_a_real_bad_password_and_success_requires_restart(self):
        for reject, reply, passed in [
            (True, {"error": "VAULT_BAD_PASSWORD"}, True),
            (True, {"value": {"restartRequired": True}}, False),
            (True, {"error": "busy"}, False),
            (False, {"value": {"restartRequired": True}}, True),
            (False, {"value": {"restartRequired": False}}, False),
            (False, {"error": "VAULT_BAD_PASSWORD"}, False),
        ]:
            def execute(script):
                return {"observation": {"done": True, **reply}} if script.startswith("return {observation:") else True
            ctx = SimpleNamespace(session=SimpleNamespace(execute=execute))
            with self.subTest(reject=reject, reply=reply):
                if passed:
                    stage(ctx, Path("/owned/original.taobak"), reject=reject)
                else:
                    with self.assertRaises(StepError):
                        stage(ctx, Path("/owned/original.taobak"), reject=reject)

    def test_only_observations_are_checks_and_yaml_cannot_select_restore_inputs(self):
        for phase in ("running-archive", "disabled-archive", "retained-archive", "staged", "restored", "restart-persisted", "reject-password", "ui-restored"):
            self.assertTrue(is_check({"module_restore_probe": {"phase": phase}}))
        for phase in ("write-original", "write-mutated", "stage", "ui-ready"):
            self.assertFalse(is_check({"module_restore_probe": {"phase": phase}}))
        for args in (None, {}, {"phase": "anything"}, {"phase": "stage", "password": "arbitrary"},
                     {"phase": "stage", "path": "/other"}, {"phase": "stage", "command": "anything"}):
            with self.subTest(args=args), self.assertRaises(StepError):
                validate(args)
