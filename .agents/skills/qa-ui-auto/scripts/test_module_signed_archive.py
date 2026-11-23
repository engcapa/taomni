"""Pure contracts for official artifact identity and the limited native oracle."""
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

import yaml

from qa_ui_auto.behavior_contract import is_check
from qa_ui_auto.ci import capabilities
from qa_ui_auto.fixtures import sockscap_legacy
from qa_ui_auto.fixtures.module_signed_archive import load_artifact, platform_key, setup, setup_mfa
from qa_ui_auto.module_qa_versions import MFA_LIFECYCLE_CASE
from qa_ui_auto.module_signed_observation import check, validate
from qa_ui_auto.steps import StepError
from qa_ui_auto.testcase import load_case

ROOT = Path(__file__).resolve().parents[4]


class OfficialModuleArtifactTests(unittest.TestCase):
    def artifact(self, root, slug="hello-plugin"):
        name = f"taomni-plugin-{slug}-0.1.0-linux-x86_64.taomni-plugin"
        archive = root / name
        with zipfile.ZipFile(archive, "w") as zipped:
            if slug == "hello-plugin":
                zipped.writestr("frontend/index.js", b"export const hello = true;\n")
            else:
                zipped.writestr("bin/taomni-plugin-mfa", b"unit payload")
        receipt = {"schema": "taomni.plugin-package.v1", "id": f"taomni-plugin-{slug}",
                   "slug": slug, "version": "0.1.0", "platform": "linux-x86_64",
                   "sourceSha": "a" * 40, "coreApiVersion": "1", "trust": "plugins.updater.pubkey",
                   "archive": name, "signature": name + ".minisig", "size": archive.stat().st_size,
                   "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
        (root / "provenance.json").write_text(json.dumps(receipt), encoding="utf-8")
        # Metadata-only fixture tests do not claim this envelope is trusted.
        # Rust signer tests exercise independent real cryptographic verification;
        # native success must still pass the unchanged product verifier.
        (root / receipt["signature"]).write_text(
            "untrusted comment: unit metadata only\nnot-a-real-signature\n"
            f"trusted comment: id=taomni-plugin-{slug} version=0.1.0 platform=linux-x86_64 coreApiVersion=1 sha256="
            + receipt["sha256"] + "\nnot-a-global-signature\n", encoding="utf-8")
        return receipt, archive

    def test_same_source_platform_identity_and_actual_bytes_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            receipt, archive = self.artifact(root)
            observed, _, _, frontend = load_artifact(root, "a" * 40, "linux-x86_64")
            self.assertEqual(observed, receipt)
            self.assertEqual(frontend, b"export const hello = true;\n")
            for source, platform in [("b" * 40, "linux-x86_64"), ("a" * 40, "darwin-aarch64")]:
                with self.assertRaisesRegex(RuntimeError, "source/platform/identity"):
                    load_artifact(root, source, platform)
            archive.write_bytes(archive.read_bytes() + b"changed")
            with self.assertRaisesRegex(RuntimeError, "digest/size"):
                load_artifact(root, "a" * 40, "linux-x86_64")

    def test_artifact_paths_cannot_select_other_files_and_no_browser_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            receipt, _ = self.artifact(root)
            receipt["archive"] = "../outside.taomni-plugin"
            (root / "provenance.json").write_text(json.dumps(receipt), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "filenames"):
                load_artifact(root, "a" * 40, "linux-x86_64")
        with self.assertRaisesRegex(RuntimeError, "native verifier"):
            setup(SimpleNamespace(cfg={"app": {"mode": "browser"}}))
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "QA_SIGNED_MODULE_ROOT"):
                setup(SimpleNamespace(cfg={"app": {"mode": "native"}}))

    def test_target_names_match_four_release_platforms(self):
        for system, machine, expected in [("Linux", "x86_64", "linux-x86_64"),
                                          ("Windows", "AMD64", "windows-x86_64"),
                                          ("Darwin", "arm64", "darwin-aarch64"),
                                          ("Darwin", "x86_64", "darwin-x86_64")]:
            self.assertEqual(platform_key(system, machine), expected)

    def test_sockscap_recovery_fixture_only_writes_its_legacy_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            context = SimpleNamespace(case_id="TC-MODULES-094", values={})
            with patch.object(sockscap_legacy, "isolated_data_root", return_value=root):
                sockscap_legacy.setup_pending_recovery(context)
            marker = root / "sockscap/recovery.json/keep.txt"
            self.assertEqual(context.values["sockscap_recovery_marker"], marker.as_posix())
            self.assertEqual(context.values["sockscap_recovery_marker_sha256"],
                             hashlib.sha256(marker.read_bytes()).hexdigest())
            self.assertFalse((root / "plugins").exists())

    def test_signed_sockscap_fixture_records_the_packaged_runtime_resource(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            archive = root / "fixture.taomni-plugin"
            manifest = json.loads((ROOT / "src-tauri/plugins/sockscap/module.json").read_text())
            resource = "resources/xray/xray"
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("taomni-plugin-sockscap", b"fixture host")
                package.writestr(manifest["entry"]["frontend"], b"fixture frontend")
                package.writestr(resource, b"fixture runtime resource")
            context = SimpleNamespace(case_id=sockscap_legacy.XRAY_CASE_ID, case_dir=root, values={},
                                      cfg={"app": {"mode": "native"}})
            with patch.dict("os.environ", {"QA_SIGNED_SOCKSCAP_ROOT": str(root)}), \
                    patch.object(sockscap_legacy, "isolated_data_root", return_value=root), \
                    patch.object(sockscap_legacy, "platform_key", return_value="linux-x86_64"), \
                    patch.object(sockscap_legacy.subprocess, "check_output", return_value="a" * 40), \
                    patch.object(sockscap_legacy, "load_artifact", return_value=({}, archive, "signature", None)):
                sockscap_legacy.setup_signed(context)
            copied = root / "signed-sockscap" / archive.name
            receipt = json.loads((copied.parent / "provenance.json").read_text())
            self.assertEqual(context.sockscap_resource_restore, (copied, resource))
            self.assertEqual(receipt["resourceSha256"], hashlib.sha256(b"fixture runtime resource").hexdigest())

    def test_mfa_case_requires_its_own_signed_module_without_a_frontend(self):
        case = load_case(ROOT / "qa-ui-auto-tests/cases/TC-MODULES-038-macos-signed-mfa-relaunch.testcase.yaml")
        self.assertEqual(case.modes, ["native"])
        self.assertIn("signed-mfa", capabilities([case], "native"))
        self.assertNotIn("signed-module", capabilities([case], "native"))
        self.assertNotIn("signed-mfa-lifecycle", capabilities([case], "native"))
        self.assertNotIn("signed-mfa", capabilities([case], "browser"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            receipt, archive = self.artifact(root, "mfa")
            observed, path, _, frontend = load_artifact(root, "a" * 40, "linux-x86_64", "mfa")
            self.assertEqual((observed, path, frontend), (receipt, archive, None))
            with self.assertRaisesRegex(RuntimeError, "source/platform/identity"):
                load_artifact(root, "a" * 40, "linux-x86_64")
        with self.assertRaisesRegex(RuntimeError, "registered native upgrade case"):
            setup_mfa(SimpleNamespace(case_id=case.id, cfg={"app": {"mode": "browser"}}))

    def test_native_mfa_lifecycle_requests_its_two_extra_signed_inputs(self):
        case = load_case(next((ROOT / "qa-ui-auto-tests/cases").glob(MFA_LIFECYCLE_CASE + "-*")))
        self.assertIn("signed-mfa", capabilities([case], "native"))
        self.assertIn("signed-mfa-lifecycle", capabilities([case], "native"))
        self.assertNotIn("signed-mfa-lifecycle", capabilities([case], "browser"))

    def test_native_oracle_does_not_accept_a_plausible_registry_without_real_ping(self):
        record = {"state": "enabled", "reason": None}
        ping = {"value": {"pluginId": "taomni-plugin-hello-plugin", "version": "0.1.0", "enabled": True}}
        check(record, ping, "enabled")
        for value in [{"value": {"enabled": True}}, {"error": {"code": -32009}},
                      {"value": {**ping["value"], "version": "0.0.0"}}]:
            with self.assertRaises(StepError):
                check(record, value, "enabled")
        with self.assertRaises(StepError):
            check({"state": "disabled"}, {"value": ping["value"]}, "disabled")
        check({"state": "disabled"}, {"error": {"code": -32009}}, "disabled")
        for args in [{"phase": "enabled", "command": "arbitrary"}, {"phase": "install"}, {"key": "test"}]:
            with self.assertRaises(StepError):
                validate(args)
        self.assertFalse(is_check({"module_signed_probe": {"phase": "tamper-frontend"}}))
        self.assertTrue(is_check({"module_signed_probe": {"phase": "enabled"}}))

    def test_case_contract_keeps_positive_native_and_negative_browser_boundaries(self):
        positive = load_case(ROOT / "qa-ui-auto-tests/cases/TC-MODULES-007-official-signed-lifecycle.testcase.yaml")
        negative = load_case(ROOT / "qa-ui-auto-tests/cases/TC-MODULES-006-signed-offline-install.testcase.yaml")
        self.assertEqual(positive.modes, ["native"])
        self.assertEqual(negative.modes, ["browser", "native"])
        self.assertIn("signed-module", capabilities([positive], "native"))
        self.assertNotIn("signed-module", capabilities([positive], "browser"))
        self.assertIn("module_signed_archive", positive.fixtures)
        self.assertGreaterEqual(sum("native_restart_app" in step for step in positive.steps), 4)

    def test_signing_job_never_checks_out_or_executes_candidate_source(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/qa-modular-packages.yml").read_text(encoding="utf-8"))
        jobs = workflow["jobs"]
        self.assertNotIn("secrets.", json.dumps(jobs["build"]))
        self.assertNotIn("secrets.", json.dumps(jobs["source"]))
        signing = jobs["sign"]["steps"]
        self.assertFalse(any("cache" in step.get("uses", "").lower() for step in signing))
        checkouts = [step for step in signing if step.get("uses", "").startswith("actions/checkout@")]
        self.assertEqual([step["with"]["ref"] for step in checkouts], ["${{ github.workflow_sha }}"])
        secret_steps = [step for step in signing if "secrets." in json.dumps(step)]
        macos_condition = "inputs.native_macos_signing && startsWith(matrix.platform, 'darwin-')"
        self.assertEqual([step["if"] for step in secret_steps], [
            macos_condition,
            "env.QA_MODULE == 'hello-plugin' || env.QA_MODULE == 'mfa'",
            "env.QA_MODULE != 'hello-plugin' && env.QA_MODULE != 'mfa'",
        ])
        guard = next(step for step in signing if step.get("name", "").startswith("Restrict QA signing"))
        for step in secret_steps:
            self.assertLess(signing.index(guard), signing.index(step),
                            "The inert candidate must be checked before a key-bearing signing step")
        macos_identity, *package_steps = secret_steps
        self.assertEqual(macos_identity["run"], "node scripts/configure-release-signing.mjs")
        self.assertEqual(macos_identity["env"]["APPLE_CERTIFICATE"], "${{ secrets.APPLE_CERTIFICATE }}")
        macos_host = next(step for step in signing if step.get("name") == "Sign and verify the macOS host")
        self.assertEqual(macos_host["if"], macos_condition)
        self.assertEqual(macos_host["run"].splitlines(), [
            'export MODULE_SLUG="$QA_MODULE"',
            'bash scripts/sign-macos-module-host.sh "candidate/unsigned-module/taomni-plugin-$MODULE_SLUG" macos-signing',
            'if [[ "$MODULE_LIFECYCLE" == \'true\' ]]; then',
            '  host="taomni-plugin-$MODULE_SLUG"',
            '  bash scripts/sign-macos-module-host.sh "candidate/unsigned-previous/$host" macos-signing/previous',
            '  cp "candidate/unsigned-module/$host" "candidate/handshake-failure/$host"',
            'fi',
        ])
        self.assertLess(signing.index(macos_identity), signing.index(macos_host))
        for step in package_steps:
            self.assertTrue(step["run"].startswith("scripts/plugin-package/target/release/taomni-plugin-package"))
            self.assertNotIn("cargo", step["run"])
            self.assertNotIn("TAURI_SIGNING_PRIVATE_KEY", step["run"])
            self.assertLess(signing.index(macos_host), signing.index(step))
        self.assertNotIn("--qa-catalog", package_steps[1]["run"])
        self.assertNotIn("release", json.dumps([step for step in signing if "upload-artifact" in step.get("uses", "")]).lower())


if __name__ == "__main__":
    unittest.main()
