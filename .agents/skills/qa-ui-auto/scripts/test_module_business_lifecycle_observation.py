"""Unit and contract tests for generalized business-module two-version lifecycles."""
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

import yaml

from qa_ui_auto import module_business_lifecycle_observation as observation
from qa_ui_auto import module_remote_lifecycle_observation as remote_lifecycle
from qa_ui_auto.behavior_contract import is_check, validate_contract
from qa_ui_auto.ci import capabilities
from qa_ui_auto.fixtures import module_marketplace, module_signed_archive, module_voice
from qa_ui_auto.module_qa_versions import (
    MAIL_LIFECYCLE_CASE,
    OFFICIAL_LIFECYCLE_SLUGS,
    SCREENSHOT_LIFECYCLE_CASE,
    SERVERS_LIFECYCLE_CASE,
    SOCKSCAP_LIFECYCLE_CASE,
    VOICE_LIFECYCLE_CASE,
    lifecycle_versions,
)
from qa_ui_auto.steps import StepError
from qa_ui_auto.testcase import load_case

ROOT = Path(__file__).resolve().parents[4]
CORE = {"pid": 1001, "started": 10.0, "executable": "/qa/taomni"}
HOST_OLD = {"pid": 1101, "started": 11.0, "executable": "/qa/old-host"}
HOST_NEW = {"pid": 2202, "started": 22.0, "executable": "/qa/new-host"}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class WindowsRemoteServerObservationTests(unittest.TestCase):
    def setUp(self):
        owner = SimpleNamespace(signed_rdp_server={"port": 27777}, signed_vnc_daemon={"port": 27777})
        session = SimpleNamespace(text=lambda selector: "No VNC server found in PATH")
        self.ctx = SimpleNamespace(fixture_context=owner, session=session)

    def test_listener_table_can_confirm_closed_port_when_loopback_times_out(self):
        table = (
            b"TCP 127.0.0.1:27777 127.0.0.1:51123 TIME_WAIT 0\n"
            b"TCP 127.0.0.1:27778 0.0.0.0:0 LISTENING 112\n"
        )
        for slug, phase in (("rdp-server", "old-disabled"), ("vnc-server", "old-enabled")):
            with self.subTest(slug=slug), \
                    patch("platform.system", return_value="Windows"), \
                    patch("socket.create_connection", side_effect=TimeoutError), \
                    patch("time.monotonic", side_effect=[0, 11]), \
                    patch("subprocess.check_output", return_value=table) as netstat:
                observed = remote_lifecycle.server_runtime(self.ctx, slug, phase, None)
                self.assertEqual(observed["port"], 27777)
                self.assertFalse(observed["listening"])
                self.assertEqual(observed["proof"], "absent-from-windows-listener-table")
                netstat.assert_called_once_with(["netstat.exe", "-ano", "-p", "tcp"], timeout=5)

    def test_timeout_does_not_hide_a_wildcard_listener(self):
        with patch("platform.system", return_value="Windows"), \
                patch("socket.create_connection", side_effect=TimeoutError), \
                patch("time.monotonic", side_effect=[0, 11]), \
                patch("subprocess.check_output", return_value=b"TCP 0.0.0.0:27777 0.0.0.0:0 LISTENING 111\n"), \
                self.assertRaisesRegex(StepError, "127.0.0.1:27777"):
            remote_lifecycle.server_runtime(self.ctx, "rdp-server", "old-disabled", None)


class BusinessLifecycleTests(unittest.TestCase):
    def test_lifecycle_versions_accept_all_ten_launch_modules(self):
        self.assertEqual(len(OFFICIAL_LIFECYCLE_SLUGS), 10)
        for slug in OFFICIAL_LIFECYCLE_SLUGS:
            prev, fail = lifecycle_versions(slug, "0.1.3")
            self.assertEqual((prev, fail), ("0.1.3-qa.previous", "0.1.4-qa.handshake-failure"))

    def _seed_installed(self, plugins: Path, slug: str, version: str, previous_version: str | None,
                        pkg_bytes: bytes, host_bytes: bytes, fe_bytes: bytes | None, retained_files=None):
        module = plugins / slug
        module.mkdir(parents=True, exist_ok=True)
        (module / "active.json").write_text(json.dumps({
            "activeVersion": version,
            "previousVersion": previous_version,
            **({"rollbackUntil": 123456} if version and previous_version else {}),
        }), encoding="utf-8")
        if version:
            vdir = module / "versions" / version
            (vdir / ".taomni-trust").mkdir(parents=True, exist_ok=True)
            (vdir / ".taomni-trust/package.taomni-plugin").write_bytes(pkg_bytes)
            (vdir / f"taomni-plugin-{slug}").write_bytes(host_bytes)
            if fe_bytes is not None:
                (vdir / "frontend").mkdir(parents=True, exist_ok=True)
                (vdir / "frontend/index.js").write_bytes(fe_bytes)
        else:
            versions = module / "versions"
            if versions.exists():
                import shutil
                shutil.rmtree(versions)
            (plugins / ".retained-data").mkdir(parents=True, exist_ok=True)
            (plugins / ".retained-data" / f"{slug}.json").write_text(json.dumps({
                "formatVersion": 1, "slug": slug, "dataSchemaVersion": 1,
                "files": retained_files if retained_files is not None else [{"path": "config.json", "kind": "file"}],
            }), encoding="utf-8")

    def _write_data(self, plugins: Path, slug: str, http_root: str):
        profile = plugins.parent
        profile.mkdir(parents=True, exist_ok=True)
        if slug in observation.STATELESS_SLUGS:
            return {"retained_files": []}
        if slug == "mail":
            account_id = "mail-acc-1"
            stem = f"{account_id}-{hashlib.sha256(account_id.encode()).hexdigest()[:16]}"
            with closing(sqlite3.connect(profile / "taomni.db")) as db:
                db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, session_type TEXT, name TEXT)")
                db.execute("INSERT INTO sessions VALUES (?, 'Mail', 'QA owned IMAP')", (account_id,))
                db.commit()
            data = plugins / "mail/data"
            data.mkdir(parents=True, exist_ok=True)
            (data / f"{stem}.imap-owner").write_text(f"taomni-imap-store-v1\n{stem}\n", encoding="utf-8")
            with closing(sqlite3.connect(data / f"{stem}.db")) as db:
                db.execute("CREATE TABLE mail_messages (account_id TEXT, folder TEXT, subject TEXT)")
                db.execute("INSERT INTO mail_messages VALUES (?, 'INBOX', 'Fresh ownership 0001')", (account_id,))
                db.commit()
            return {"retained_files": [
                {"path": f"{stem}.db", "kind": "sqlite"},
                {"path": f"{stem}.imap-owner", "kind": "file"},
            ]}
        data = plugins / slug / "data"
        data.mkdir(parents=True, exist_ok=True)
        if slug == "servers":
            payload = {"settings": {"http": {"port": 28489, "bindAddress": "127.0.0.1", "rootDir": http_root}}}
        else:
            payload = {"upstream": {"kind": "trojan", "host": "127.0.0.2", "port": 19392, "passwordRef": "vault:abc"}}
        (data / "config.json").write_text(json.dumps(payload), encoding="utf-8")
        return {"retained_files": [{"path": "config.json", "kind": "file"}]}

    def test_all_ten_lifecycle_phases_and_data_continuity_verify_cleanly(self):
        for slug, case_id in (
            ("servers", SERVERS_LIFECYCLE_CASE),
            ("sockscap", SOCKSCAP_LIFECYCLE_CASE),
            ("screenshot", SCREENSHOT_LIFECYCLE_CASE),
            ("ai-voice-local", VOICE_LIFECYCLE_CASE),
            ("mail", MAIL_LIFECYCLE_CASE),
        ):
            with self.subTest(slug=slug), tempfile.TemporaryDirectory() as directory:
                profile = Path(directory).resolve() / "profile"
                plugins = profile / "plugins"
                case_dir = Path(directory).resolve() / "case"
                case_dir.mkdir(parents=True)
                http_root = str(Path(directory).resolve() / "docroot")
                old_pkg, new_pkg, fail_pkg = b"old-pkg", b"new-pkg", b"fail-pkg"
                old_host, new_host = b"old-host", b"new-host"
                fe = None if slug == "ai-voice-local" else b"export default () => null;"
                (plugins / ".downloads").mkdir(parents=True)
                (plugins / ".downloads" / f"{_sha256(new_pkg)}.taomni-plugin").write_bytes(new_pkg)
                fe_hash = {"frontendSha256": _sha256(fe)} if fe is not None else {}
                packages = {
                    "previous": {
                        "version": "0.1.2-qa.previous", "platform": "linux-x86_64", "sourceSha": "a" * 40,
                        "sha256": _sha256(old_pkg), "hostSha256": _sha256(old_host), **fe_hash,
                        "archive": f"{slug}-prev.taomni-plugin",
                    },
                    "current": {
                        "version": "0.1.2", "platform": "linux-x86_64", "sourceSha": "a" * 40,
                        "sha256": _sha256(new_pkg), "hostSha256": _sha256(new_host), **fe_hash,
                        "archive": f"{slug}-cur.taomni-plugin",
                    },
                    "failed": {
                        "version": "0.1.3-qa.handshake-failure", "platform": "linux-x86_64", "sourceSha": "a" * 40,
                        "sha256": _sha256(fail_pkg), "hostSha256": _sha256(new_host), **fe_hash,
                        "archive": f"{slug}-fail.taomni-plugin",
                    },
                }
                model_path = Path(directory).resolve() / "cache/ggml-base.bin"
                model_path.parent.mkdir(parents=True)
                model_path.write_bytes(b"whisper-base-weights")
                owner = SimpleNamespace(
                    case_id=case_id,
                    values={"local_servers_http_root": http_root},
                    local_voice_model_path=model_path,
                    local_voice_model_sha256=_sha256(b"whisper-base-weights"),
                    module_lifecycle={slug: packages},
                    module_marketplace=SimpleNamespace(requests=["/" + packages["current"]["archive"]]),
                )
                ctx = SimpleNamespace(case_dir=case_dir, fixture_context=owner, session=None)
                meta = self._write_data(plugins, slug, http_root)

                for phase in (
                    "old-enabled", "old-disabled", "updated-disabled", "rolled-back-disabled",
                    "old-reenabled", "updated-enabled", "failed-update", "rolled-back-enabled",
                    "uninstalled", "reinstalled",
                ):
                    label, prev_label, state = observation.STATES[phase]
                    selected = packages[label] if label else None
                    prev = packages[prev_label]["version"] if prev_label else None
                    pkg_bytes = old_pkg if label == "previous" else new_pkg
                    host_bytes = old_host if label == "previous" else new_host
                    self._seed_installed(
                        plugins, slug, selected["version"] if selected else None, prev, pkg_bytes, host_bytes, fe,
                        retained_files=meta["retained_files"],
                    )
                    if phase == "failed-update":
                        staged = plugins / slug / "versions" / packages["failed"]["version"] / ".taomni-trust/package.taomni-plugin"
                        staged.parent.mkdir(parents=True, exist_ok=True)
                        staged.write_bytes(fail_pkg)
                    reg_record = {"manifest": {"slug": slug, "version": selected["version"] if selected else None},
                                  "state": state, "reason": None, "dataRetained": slug not in observation.STATELESS_SLUGS}
                    with patch("qa_ui_auto.fixtures.backup_policy.isolated_data_root", return_value=profile), \
                         patch.object(observation, "writer_lease", return_value={"exists": True, "held": state == "enabled"}), \
                         patch.object(observation, "inspect_module_process", return_value=(CORE, HOST_NEW if state == "enabled" else None)), \
                         patch.object(observation, "invoke", return_value={"value": [reg_record]}):
                        result = observation.run(ctx, {"slug": slug, "phase": phase})
                    self.assertIn(phase, result)

                lines = (case_dir / f"signed-{slug}-lifecycle.jsonl").read_text(encoding="utf-8").splitlines()
                self.assertEqual(len(lines), 10)
                self.assertTrue(all(json.loads(line)["passed"] for line in lines))

    def test_rejects_drifted_config_or_missing_retained_locator(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory).resolve() / "profile"
            plugins = profile / "plugins"
            case_dir = Path(directory).resolve() / "case"
            case_dir.mkdir(parents=True)
            self._write_data(plugins, "sockscap", "")
            owner = SimpleNamespace(values={"local_servers_http_root": ""})
            observation.verify_module_data(owner, "sockscap", plugins / "sockscap")
            (plugins / "sockscap/data/config.json").write_text(
                json.dumps({"upstream": {"kind": "trojan", "host": "127.0.0.2", "port": 19392, "passwordRef": "vault:changed"}}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(StepError, "altered its retained"):
                observation.verify_module_data(owner, "sockscap", plugins / "sockscap")
            with self.assertRaisesRegex(StepError, "registered"):
                observation.validate({"slug": "hello", "phase": "old-enabled"})

    def test_marketplace_routes_business_lifecycle_cases(self):
        for case_id, env_var, slug in (
            (SERVERS_LIFECYCLE_CASE, "QA_SIGNED_SERVERS_ROOT", "servers"),
            (SOCKSCAP_LIFECYCLE_CASE, "QA_SIGNED_SOCKSCAP_ROOT", "sockscap"),
            (SCREENSHOT_LIFECYCLE_CASE, "QA_SIGNED_SCREENSHOT_ROOT", "screenshot"),
            (VOICE_LIFECYCLE_CASE, "QA_SIGNED_LOCAL_VOICE_ROOT", "ai-voice-local"),
            (MAIL_LIFECYCLE_CASE, "QA_SIGNED_MAIL_ROOT", "mail"),
        ):
            with self.subTest(case_id=case_id), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                receipt = {"id": f"taomni-plugin-{slug}", "slug": slug, "archive": f"{slug}.taomni-plugin"}
                ctx = SimpleNamespace(case_id=case_id, case_dir=root, cfg={"app": {"mode": "native"}},
                                      module_lifecycle={slug: {"current": receipt}})
                with patch.dict("os.environ", {env_var: str(root)}), \
                     patch.object(module_marketplace, "plugin_root", return_value=root / "plugins"), \
                     patch.object(module_marketplace, "fixture_files", return_value={"modules.json": b"{}"}) as loader, \
                     patch.object(module_marketplace, "Origin", return_value="origin"):
                    module_marketplace.setup(ctx)
                loader.assert_called_once_with(root, receipt, include_tampered=False)

    def test_setup_servers_skips_legacy_db_for_lifecycle_case(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            archive = root / "servers.taomni-plugin"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("taomni-plugin-servers", b"cur-bin")
                zf.writestr("frontend/index.js", b"fe")
            receipt = {"id": "taomni-plugin-servers", "slug": "servers", "version": "0.1.3",
                       "platform": "linux-x86_64", "sourceSha": "a" * 40, "archive": archive.name,
                       "sha256": "0" * 64, "signature": archive.name + ".minisig"}
            ctx = SimpleNamespace(case_id=SERVERS_LIFECYCLE_CASE, case_dir=root, cfg={"app": {"mode": "native"}},
                                  values={"local_servers_http_root": str(root / "docroot")})
            with patch.dict("os.environ", {"QA_SIGNED_SERVERS_ROOT": str(root)}), \
                 patch.object(module_signed_archive, "isolated_data_root", return_value=root / "profile"), \
                 patch.object(module_signed_archive, "platform_key", return_value="linux-x86_64"), \
                 patch.object(module_signed_archive.subprocess, "check_output", return_value="a" * 40), \
                 patch.object(module_signed_archive, "load_artifact", return_value=(receipt, archive, "sig", b"fe")), \
                 patch.object(module_signed_archive, "setup_business_lifecycle", return_value={"current": receipt}) as helper:
                module_signed_archive.setup_servers(ctx)
            helper.assert_called_once()
            self.assertFalse((root / "profile/taomni.db").exists())

    def test_rejects_stateless_data_dir_drifted_voice_model_or_missing_mail_locator(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory).resolve() / "profile"
            plugins = profile / "plugins"
            case_dir = Path(directory).resolve() / "case"
            case_dir.mkdir(parents=True)
            (plugins / "screenshot/data").mkdir(parents=True)
            with self.assertRaisesRegex(StepError, "unexpectedly created data directory"):
                observation.verify_module_data(SimpleNamespace(), "screenshot", plugins / "screenshot")

            model = Path(directory).resolve() / "ggml-base.bin"
            model.write_bytes(b"original-model")
            voice_owner = SimpleNamespace(local_voice_model_path=model, local_voice_model_sha256=_sha256(b"other"))
            with self.assertRaisesRegex(StepError, "model cache drifted"):
                observation.verify_module_data(voice_owner, "ai-voice-local", plugins / "ai-voice-local")

            mail_meta = self._write_data(plugins, "mail", "")
            self._seed_installed(
                plugins, "mail", None, "0.1.57-qa.previous", b"p", b"h", b"f",
                retained_files=[mail_meta["retained_files"][0]],
            )
            mail_owner = SimpleNamespace(case_id=MAIL_LIFECYCLE_CASE, module_lifecycle={"mail": {
                "previous": {"version": "0.1.57-qa.previous"},
                "current": {"sourceSha": "a" * 40, "platform": "linux-x86_64"},
            }})
            ctx = SimpleNamespace(case_dir=case_dir, fixture_context=mail_owner, session=None)
            reg_record = {"manifest": {"slug": "mail", "version": None}, "state": "uninstalled",
                          "reason": None, "dataRetained": True}
            with patch("qa_ui_auto.fixtures.backup_policy.isolated_data_root", return_value=profile), \
                 patch.object(observation, "writer_lease", return_value={"exists": True, "held": False}), \
                 patch.object(observation, "inspect_module_process", return_value=(CORE, None)), \
                 patch.object(observation, "invoke", return_value={"value": [reg_record]}), \
                 self.assertRaisesRegex(StepError, "retained locator"):
                observation.run(ctx, {"slug": "mail", "phase": "uninstalled"})

    def test_signed_business_case_contracts_are_valid_across_all_three_platforms(self):
        for slug, case_id in observation.REGISTERED_CASES.items():
            path = next((ROOT / "qa-ui-auto-tests/cases").glob(f"{case_id}-*.testcase.yaml"))
            case = load_case(path)
            self.assertEqual(case.modes, ["native"])
            self.assertEqual(case.native_platforms, ["Linux", "Windows", "macOS"])
            self.assertFalse(any(cap.startswith("signed-") for cap in capabilities([case], "browser")))
            checks = [step["assert_signed_module_lifecycle"] for step in case.steps
                      if "assert_signed_module_lifecycle" in step]
            self.assertEqual(checks, [{"slug": slug, "phase": phase} for phase in observation.STATES])
            self.assertTrue(all(is_check({"assert_signed_module_lifecycle": check}) for check in checks))
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            self.assertEqual(validate_contract(doc, require_review=True), [])


if __name__ == "__main__":
    unittest.main()
