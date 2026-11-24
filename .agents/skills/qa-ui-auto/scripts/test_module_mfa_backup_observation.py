"""Pure unit and case-contract tests for signed MFA 3-state automatic restore."""
from __future__ import annotations

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

from qa_ui_auto import module_mfa_backup_observation as observation
from qa_ui_auto.behavior_contract import is_check, validate_contract
from qa_ui_auto.ci import capabilities
from qa_ui_auto.fixtures.module_mfa_restore import SIGNED_BACKUP_STATES
from qa_ui_auto.steps import StepError
from qa_ui_auto.testcase import load_case

ROOT = Path(__file__).resolve().parents[4]
BEFORE_GEN = "a1234567-1234-1234-1234-123456789abc"
AFTER_GEN = "b1234567-1234-1234-1234-123456789abc"
JOB_ID = "c1234567-1234-1234-1234-123456789abc"
CORE_BEFORE = {"pid": 1001, "started": 10.0, "executable": "/qa/taomni"}
CORE_AFTER = {"pid": 2002, "started": 20.0, "executable": "/qa/taomni"}
HOST_1 = {"pid": 1101, "started": 11.0, "executable": "/qa/mfa"}
HOST_2 = {"pid": 2202, "started": 22.0, "executable": "/qa/mfa"}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_mfa_db(path: Path, counter: int, secret_ct: bytes = b"x" * 32) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("DROP TABLE IF EXISTS mfa_accounts")
        db.execute(
            "CREATE TABLE mfa_accounts(id TEXT, issuer TEXT, kind TEXT, counter INTEGER, secret_ct BLOB, secret_nonce BLOB)"
        )
        db.execute(
            "INSERT INTO mfa_accounts VALUES ('acct-1', ?, 'hotp', ?, ?, ?)",
            (observation.ISSUER, counter, secret_ct, b"n" * 12),
        )


def _write_vault_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("DROP TABLE IF EXISTS vault_meta")
        db.execute("CREATE TABLE vault_meta(id INTEGER PRIMARY KEY)")


def _build_v2_archive(
    path: Path,
    *,
    generation: str = BEFORE_GEN,
    counter: int = 0,
    include_vault: bool = True,
    include_legacy_mfa: bool = False,
    extra_plugin_file: str | None = None,
    corrupt_mfa_hash: bool = False,
) -> Path:
    work = path.parent / "zip-src"
    work.mkdir(exist_ok=True)
    mfa_file = work / "mfa.db"
    vault_file = work / "vault.db"
    _write_mfa_db(mfa_file, counter)
    _write_vault_db(vault_file)

    payloads: dict[str, bytes] = {"plugins/mfa/data/mfa.db": mfa_file.read_bytes()}
    if include_vault:
        payloads["databases/vault.db"] = vault_file.read_bytes()
    if include_legacy_mfa:
        payloads["databases/mfa.db"] = mfa_file.read_bytes()
    if extra_plugin_file:
        payloads[extra_plugin_file] = b"unexpected-sidecar"

    files_meta = []
    for rel, raw in payloads.items():
        digest = _sha256(raw)
        if corrupt_mfa_hash and rel == "plugins/mfa/data/mfa.db":
            digest = "0" * 64
        files_meta.append({"path": rel, "sha256": digest, "sizeBytes": len(raw)})

    manifest = {
        "formatVersion": 2,
        "pluginDatasets": [
            {
                "slug": "mfa",
                "dataSchemaVersion": 1,
                "requiresVault": True,
                "profileGeneration": generation,
                "files": [{"path": "mfa.db", "kind": "sqlite"}],
                "job": JOB_ID,
            }
        ],
        "files": files_meta,
    }
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for rel, raw in payloads.items():
            archive.writestr(rel, raw)
    return path


class SignedMfaBackupObservationTests(unittest.TestCase):
    def _setup_profile(self, root: Path, case_id: str):
        work = root / "case"
        work.mkdir(parents=True, exist_ok=True)
        profile = root / "profile"
        plugins = profile / "plugins"
        module = plugins / "mfa"
        version_dir = module / "versions/0.1.2"
        (version_dir / ".taomni-trust").mkdir(parents=True)
        (version_dir / "frontend").mkdir(parents=True)
        pkg = version_dir / ".taomni-trust/package.taomni-plugin"
        host = version_dir / "taomni-plugin-mfa"
        frontend = version_dir / "frontend/index.js"
        pkg.write_bytes(b"signed-pkg")
        host.write_bytes(b"signed-host")
        frontend.write_bytes(b"signed-frontend")
        (module / "active.json").write_text(json.dumps({"activeVersion": "0.1.2"}), encoding="utf-8")
        (profile / ".profile-state.json").write_text(json.dumps({"generation": BEFORE_GEN}), encoding="utf-8")
        _write_mfa_db(module / "data/mfa.db", 0)

        receipt = {
            "version": "0.1.2",
            "platform": "linux-x86_64",
            "sourceSha": "a" * 40,
            "sha256": _sha256(pkg.read_bytes()),
            "hostSha256": _sha256(host.read_bytes()),
            "frontendSha256": _sha256(frontend.read_bytes()),
        }
        owner = SimpleNamespace(case_id=case_id, case_dir=work, values={}, signed_mfa_backup=receipt)
        session = SimpleNamespace(application=Path("/qa/taomni"), restore_relaunch_observation={})
        ctx = SimpleNamespace(case_dir=work, fixture_context=owner, session=session)
        return ctx, owner, profile, plugins, module, version_dir

    def _set_uninstalled(self, plugins: Path, module: Path, version_dir: Path, state_active: bool) -> None:
        import shutil

        if not state_active:
            if version_dir.exists():
                shutil.rmtree(module / "versions")
            (module / "active.json").write_text(json.dumps({"activeVersion": None, "previousVersion": "0.1.2"}), encoding="utf-8")
            control = plugins / ".retained-data"
            control.mkdir(exist_ok=True)
            (control / "mfa.json").write_text(json.dumps(observation.EXPECTED_LOCATOR), encoding="utf-8")
        else:
            vdir = module / "versions/0.1.2"
            (vdir / ".taomni-trust").mkdir(parents=True, exist_ok=True)
            (vdir / "frontend").mkdir(parents=True, exist_ok=True)
            (vdir / ".taomni-trust/package.taomni-plugin").write_bytes(b"signed-pkg")
            (vdir / "taomni-plugin-mfa").write_bytes(b"signed-host")
            (vdir / "frontend/index.js").write_bytes(b"signed-frontend")
            (module / "active.json").write_text(json.dumps({"activeVersion": "0.1.2"}), encoding="utf-8")

    def test_all_five_phases_across_enabled_disabled_and_uninstalled_states(self):
        for case_id, target_state in SIGNED_BACKUP_STATES.items():
            with self.subTest(case_id=case_id, target_state=target_state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                ctx, owner, profile, plugins, module, version_dir = self._setup_profile(root, case_id)
                archive_path = _build_v2_archive(profile / "manual-backup.taobak")

                def reg(state_value: str) -> dict:
                    return {
                        "value": [
                            {
                                "manifest": {"slug": "mfa", "version": "0.1.2"},
                                "state": state_value,
                                "dataRetained": True,
                                "reason": None,
                            }
                        ]
                    }

                with patch.object(observation, "isolated_data_root", return_value=profile), \
                     patch.object(observation, "writer_lease", return_value={"exists": True, "held": True}), \
                     patch.object(observation, "observe_mfa_processes", return_value=(CORE_BEFORE, HOST_1)), \
                     patch.object(observation, "invoke", return_value=reg("enabled")):
                    self.assertIn("initial", observation.run(ctx, "initial"))

                if target_state == "uninstalled":
                    self._set_uninstalled(plugins, module, version_dir, state_active=False)

                with patch.object(observation, "isolated_data_root", return_value=profile), \
                     patch.object(observation, "writer_lease", return_value={"exists": True, "held": target_state == "enabled"}), \
                     patch.object(observation, "observe_mfa_processes", return_value=(CORE_BEFORE, HOST_1 if target_state == "enabled" else None)), \
                     patch.object(observation, "wait_manual_job", return_value=(JOB_ID, {"localPath": str(archive_path)})), \
                     patch.object(observation, "invoke", return_value=reg(target_state)):
                    self.assertIn("archive", observation.run(ctx, "archive"))
                self.assertEqual(owner.values["signed_mfa_restore_job_id"], JOB_ID)

                if target_state == "uninstalled":
                    self._set_uninstalled(plugins, module, version_dir, state_active=True)
                _write_mfa_db(module / "data/mfa.db", 1)
                if target_state == "uninstalled":
                    self._set_uninstalled(plugins, module, version_dir, state_active=False)

                with patch.object(observation, "isolated_data_root", return_value=profile), \
                     patch.object(observation, "writer_lease", return_value={"exists": True, "held": target_state == "enabled"}), \
                     patch.object(observation, "observe_mfa_processes", return_value=(CORE_BEFORE, HOST_1 if target_state == "enabled" else None)), \
                     patch.object(observation, "invoke", return_value=reg(target_state)):
                    self.assertIn("ready", observation.run(ctx, "ready"))

                # Apply restore: generation advances and mfa.db rolls back to exact archived SQLite bytes.
                (profile / ".profile-state.json").write_text(json.dumps({"generation": AFTER_GEN}), encoding="utf-8")
                with zipfile.ZipFile(archive_path) as archive:
                    (module / "data/mfa.db").write_bytes(archive.read("plugins/mfa/data/mfa.db"))
                ctx.session.restore_relaunch_observation = {
                    "passed": True,
                    "manual_launch": False,
                    "original_exit_code": 0,
                    "before": {"pid": CORE_BEFORE["pid"]},
                    "after": {"pid": CORE_AFTER["pid"]},
                }
                lease_result = {"exists": False, "held": False}
                proc_result = (CORE_AFTER, None)
                with patch.object(observation, "isolated_data_root", return_value=profile), \
                     patch.object(observation, "writer_lease", return_value=lease_result), \
                     patch.object(observation, "observe_mfa_processes", return_value=proc_result), \
                     patch.object(observation, "invoke", return_value=reg(target_state)):
                    self.assertIn("restored", observation.run(ctx, "restored"))

                if target_state == "uninstalled":
                    self._set_uninstalled(plugins, module, version_dir, state_active=True)
                _write_mfa_db(module / "data/mfa.db", 1)
                with patch.object(observation, "isolated_data_root", return_value=profile), \
                     patch.object(observation, "writer_lease", return_value={"exists": True, "held": True}), \
                     patch.object(observation, "observe_mfa_processes", return_value=(CORE_AFTER, HOST_2)), \
                     patch.object(observation, "invoke", return_value=reg("enabled")):
                    self.assertIn("reopened", observation.run(ctx, "reopened"))

                lines = (ctx.case_dir / "signed-mfa-backup.jsonl").read_text(encoding="utf-8").splitlines()
                self.assertEqual(len(lines), 5)
                self.assertTrue(all(json.loads(line)["passed"] for line in lines))

    def test_archive_and_restored_rejections_catch_tampering_and_missing_relaunch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            expected_account = {"id": "acct-1", "counter": 0, "encryptedSecretSha256": _sha256(b"x" * 32 + b"n" * 12)}
            bad_cases = [
                ("legacy_mfa", dict(include_legacy_mfa=True)),
                ("missing_vault", dict(include_vault=False)),
                ("corrupt_hash", dict(corrupt_mfa_hash=True)),
                ("wrong_gen", dict(generation=AFTER_GEN)),
                ("wrong_counter", dict(counter=1)),
                ("sidecar_in_zip", dict(extra_plugin_file="plugins/mfa/data/mfa.db-wal")),
            ]
            for label, kwargs in bad_cases:
                with self.subTest(archive_fault=label):
                    archive = _build_v2_archive(root / f"{label}.taobak", **kwargs)
                    with self.assertRaises(StepError):
                        observation.check_mfa_v2_archive(archive, root, BEFORE_GEN, expected_account)

            # Retained locator / DB bytes / relaunch checks.
            ctx, _, profile, plugins, module, version_dir = self._setup_profile(root / "uninstalled", "TC-MODULES-106")
            self._set_uninstalled(plugins, module, version_dir, state_active=False)
            with self.assertRaises(StepError):
                observation.check_uninstalled_retained(plugins, module, {"state": "uninstalled", "dataRetained": False})
            (plugins / ".retained-data/mfa.json").write_text(json.dumps({"slug": "wrong"}), encoding="utf-8")
            with self.assertRaises(StepError):
                observation.check_uninstalled_retained(plugins, module, {"state": "uninstalled", "dataRetained": True})
            (plugins / ".retained-data/mfa.json").write_text(json.dumps(observation.EXPECTED_LOCATOR), encoding="utf-8")
            with self.assertRaises(StepError):
                observation.check_uninstalled_retained(plugins, module, {"state": "uninstalled", "dataRetained": True}, expected_db_sha256="0" * 64)
            (profile / "mfa.db").write_bytes(b"legacy")
            with self.assertRaises(StepError):
                observation.check_legacy_mfa_absent(profile)

    def test_restored_rejects_missing_relaunch_unchanged_generation_and_altered_active_json(self):
        for fault in ("missing_relaunch", "same_generation", "altered_pointer"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                ctx, _, profile, _, module, _ = self._setup_profile(root, "TC-MODULES-104")
                archive = _build_v2_archive(profile / "ok.taobak")
                state = {
                    "step": "ready",
                    "expectedState": "enabled",
                    "generation": BEFORE_GEN,
                    "account": {"id": "acct-1", "counter": 0, "encryptedSecretSha256": _sha256(b"x" * 32 + b"n" * 12)},
                    "core": CORE_BEFORE,
                    "host": HOST_1,
                    "archive": str(archive),
                    "archiveSha256": _sha256(archive.read_bytes()),
                    "archiveMfaSha256": "unused",
                    "activePointerSha256": _sha256((module / "active.json").read_bytes()),
                }
                (ctx.case_dir / "signed-mfa-backup-state.json").write_text(json.dumps(state), encoding="utf-8")
                if fault != "same_generation":
                    (profile / ".profile-state.json").write_text(json.dumps({"generation": AFTER_GEN}), encoding="utf-8")
                if fault == "altered_pointer":
                    (module / "active.json").write_text(json.dumps({"activeVersion": "9.9.9"}), encoding="utf-8")
                if fault != "missing_relaunch":
                    ctx.session.restore_relaunch_observation = {
                        "passed": True,
                        "manual_launch": False,
                        "original_exit_code": 0,
                        "before": {"pid": CORE_BEFORE["pid"]},
                        "after": {"pid": CORE_AFTER["pid"]},
                    }
                with patch.object(observation, "isolated_data_root", return_value=profile), \
                     patch.object(observation, "writer_lease", return_value={"exists": True, "held": True}), \
                     patch.object(observation, "observe_mfa_processes", return_value=(CORE_AFTER, HOST_2)), \
                     patch.object(observation, "invoke", return_value={"value": [{"manifest": {"slug": "mfa"}, "state": "enabled", "reason": None}]}):
                    with self.assertRaises(StepError):
                        observation.run(ctx, "restored")

    def test_cases_register_signed_mfa_and_exact_restore_relaunch_sequence(self):
        for phase in observation.PHASES:
            self.assertTrue(is_check({"assert_signed_mfa_backup": phase}))
        for case_id in SIGNED_BACKUP_STATES:
            path = next((ROOT / "qa-ui-auto-tests/cases").glob(f"{case_id}-*.testcase.yaml"))
            case = load_case(path)
            self.assertEqual(case.modes, ["native"])
            self.assertEqual(case.native_platforms, ["Linux", "Windows", "macOS"])
            self.assertIn("signed-mfa", capabilities([case], "native"))
            self.assertNotIn("signed-mfa-lifecycle", capabilities([case], "native"))
            self.assertNotIn("signed-module", capabilities([case], "native"))
            restore_clicks = [
                step["click"]
                for step in case.steps
                if isinstance(step.get("click"), str) and "backup-local-restore" in step["click"]
            ]
            self.assertEqual(
                restore_clicks,
                ['[data-testid="backup-cloud-job"][data-job-id="${fixture.signed_mfa_restore_job_id}"] [data-testid="backup-local-restore"]'],
            )
            relaunch_indices = [i for i, step in enumerate(case.steps) if "native_confirm_restore_relaunch" in step]
            self.assertEqual(len(relaunch_indices), 1)
            idx = relaunch_indices[0]
            self.assertEqual(case.steps[idx - 2], {"assert_signed_mfa_backup": "ready"})
            self.assertEqual(case.steps[idx + 2], {"assert_signed_mfa_backup": "restored"})
            import yaml

            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            self.assertEqual(validate_contract(doc, require_review=True), [])


if __name__ == "__main__":
    unittest.main()
