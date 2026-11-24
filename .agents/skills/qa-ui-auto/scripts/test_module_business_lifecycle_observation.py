"""Unit and contract tests for generalized business-module two-version lifecycles."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

import yaml

from qa_ui_auto import module_business_lifecycle_observation as observation
from qa_ui_auto.behavior_contract import is_check, validate_contract
from qa_ui_auto.ci import capabilities
from qa_ui_auto.fixtures import module_marketplace, module_signed_archive
from qa_ui_auto.module_qa_versions import OFFICIAL_LIFECYCLE_SLUGS, SERVERS_LIFECYCLE_CASE, SOCKSCAP_LIFECYCLE_CASE, lifecycle_versions
from qa_ui_auto.steps import StepError
from qa_ui_auto.testcase import load_case

ROOT = Path(__file__).resolve().parents[4]
CORE = {"pid": 1001, "started": 10.0, "executable": "/qa/taomni"}
HOST_OLD = {"pid": 1101, "started": 11.0, "executable": "/qa/old-host"}
HOST_NEW = {"pid": 2202, "started": 22.0, "executable": "/qa/new-host"}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class BusinessLifecycleTests(unittest.TestCase):
    def test_lifecycle_versions_accept_all_ten_launch_modules(self):
        self.assertEqual(len(OFFICIAL_LIFECYCLE_SLUGS), 10)
        for slug in OFFICIAL_LIFECYCLE_SLUGS:
            prev, fail = lifecycle_versions(slug, "0.1.3")
            self.assertEqual((prev, fail), ("0.1.3-qa.previous", "0.1.4-qa.handshake-failure"))

    def _seed_installed(self, plugins: Path, slug: str, version: str, previous_version: str | None,
                        pkg_bytes: bytes, host_bytes: bytes, fe_bytes: bytes):
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
            (vdir / "frontend").mkdir(parents=True, exist_ok=True)
            (vdir / ".taomni-trust/package.taomni-plugin").write_bytes(pkg_bytes)
            (vdir / f"taomni-plugin-{slug}").write_bytes(host_bytes)
            (vdir / "frontend/index.js").write_bytes(fe_bytes)
        else:
            versions = module / "versions"
            if versions.exists():
                import shutil
                shutil.rmtree(versions)
            (plugins / ".retained-data").mkdir(parents=True, exist_ok=True)
            (plugins / ".retained-data" / f"{slug}.json").write_text(json.dumps({
                "formatVersion": 1, "slug": slug, "dataSchemaVersion": 1,
                "files": [{"path": "config.json", "kind": "file"}],
            }), encoding="utf-8")

    def _write_data(self, plugins: Path, slug: str, http_root: str):
        data = plugins / slug / "data"
        data.mkdir(parents=True, exist_ok=True)
        if slug == "servers":
            payload = {"settings": {"http": {"port": 28489, "bindAddress": "127.0.0.1", "rootDir": http_root}}}
        else:
            payload = {"upstream": {"kind": "trojan", "host": "127.0.0.2", "port": 19392, "passwordRef": "vault:abc"}}
        (data / "config.json").write_text(json.dumps(payload), encoding="utf-8")

    def test_all_ten_lifecycle_phases_and_data_continuity_verify_cleanly(self):
        for slug, case_id in (("servers", SERVERS_LIFECYCLE_CASE), ("sockscap", SOCKSCAP_LIFECYCLE_CASE)):
            with self.subTest(slug=slug), tempfile.TemporaryDirectory() as directory:
                profile = Path(directory).resolve() / "profile"
                plugins = profile / "plugins"
                case_dir = Path(directory).resolve() / "case"
                case_dir.mkdir(parents=True)
                http_root = str(Path(directory).resolve() / "docroot")
                old_pkg, new_pkg, fail_pkg = b"old-pkg", b"new-pkg", b"fail-pkg"
                old_host, new_host = b"old-host", b"new-host"
                fe = b"export default () => null;"
                (plugins / ".downloads").mkdir(parents=True)
                (plugins / ".downloads" / f"{_sha256(new_pkg)}.taomni-plugin").write_bytes(new_pkg)
                packages = {
                    "previous": {
                        "version": "0.1.2-qa.previous", "platform": "linux-x86_64", "sourceSha": "a" * 40,
                        "sha256": _sha256(old_pkg), "hostSha256": _sha256(old_host), "frontendSha256": _sha256(fe),
                        "archive": f"{slug}-prev.taomni-plugin",
                    },
                    "current": {
                        "version": "0.1.2", "platform": "linux-x86_64", "sourceSha": "a" * 40,
                        "sha256": _sha256(new_pkg), "hostSha256": _sha256(new_host), "frontendSha256": _sha256(fe),
                        "archive": f"{slug}-cur.taomni-plugin",
                    },
                    "failed": {
                        "version": "0.1.3-qa.handshake-failure", "platform": "linux-x86_64", "sourceSha": "a" * 40,
                        "sha256": _sha256(fail_pkg), "hostSha256": _sha256(new_host), "frontendSha256": _sha256(fe),
                        "archive": f"{slug}-fail.taomni-plugin",
                    },
                }
                owner = SimpleNamespace(
                    case_id=case_id,
                    values={"local_servers_http_root": http_root},
                    module_lifecycle={slug: packages},
                    module_marketplace=SimpleNamespace(requests=["/" + packages["current"]["archive"]]),
                )
                ctx = SimpleNamespace(case_dir=case_dir, fixture_context=owner, session=None)
                self._write_data(plugins, slug, http_root)

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
                    )
                    if phase == "failed-update":
                        staged = plugins / slug / "versions" / packages["failed"]["version"] / ".taomni-trust/package.taomni-plugin"
                        staged.parent.mkdir(parents=True, exist_ok=True)
                        staged.write_bytes(fail_pkg)
                    reg_record = {"manifest": {"slug": slug, "version": selected["version"] if selected else None},
                                  "state": state, "reason": None, "dataRetained": True}
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

    def test_wave1_case_contracts_are_valid_across_all_three_platforms(self):
        for phase in observation.STATES:
            for slug in ("servers", "sockscap"):
                self.assertTrue(is_check({"assert_signed_module_lifecycle": {"slug": slug, "phase": phase}}))
        for case_id in (SERVERS_LIFECYCLE_CASE, SOCKSCAP_LIFECYCLE_CASE):
            path = next((ROOT / "qa-ui-auto-tests/cases").glob(f"{case_id}-*.testcase.yaml"))
            case = load_case(path)
            self.assertEqual(case.modes, ["native"])
            self.assertEqual(case.native_platforms, ["Linux", "Windows", "macOS"])
            self.assertEqual(capabilities([case], "browser"), [])
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            self.assertEqual(validate_contract(doc, require_review=True), [])


if __name__ == "__main__":
    unittest.main()
