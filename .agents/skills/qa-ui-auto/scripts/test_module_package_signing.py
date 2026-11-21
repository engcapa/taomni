"""Execute the workflow's inert-payload guard without keys or host processes."""
from contextlib import chdir
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[4]
PLATFORMS = ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"]


class OfficialPackageSigningGuardTests(unittest.TestCase):
    def seed_payload(self, root, module, platform, folder):
        trusted = root / "src-tauri/plugins" / module
        trusted.mkdir(parents=True)
        shutil.copyfile(ROOT / "src-tauri/plugins" / module / "module.json", trusted / "module.json")
        manifest = json.loads((trusted / "module.json").read_text())
        payload = root / "candidate" / folder
        payload.mkdir(parents=True)
        if platform.startswith("windows"):
            manifest["entry"]["host"] += ".exe"
        (payload / manifest["entry"]["host"]).write_bytes(b"inert unit host; never executed")
        if module == "vnc-client" and platform == "windows-x86_64":
            (payload / "taomni-vnc-key-helper.exe").write_bytes(b"inert unit helper")
        frontend = manifest["entry"].get("frontend")
        if frontend and module != "vnc-client":
            shutil.copytree(ROOT / "src-tauri/plugins" / module / "frontend", trusted / "frontend")
            shutil.copytree(trusted / "frontend", payload / "frontend")
        (payload / "module.json").write_text(json.dumps(manifest))
        return payload

    def seed(self, root, module, platform):
        payload = self.seed_payload(root, module, platform, "unsigned-module")
        if module == "hello-plugin":
            previous = root / "candidate/unsigned-previous"
            shutil.copytree(payload, previous)
            manifest = json.loads((payload / "module.json").read_text())
            (previous / "module.json").write_text(json.dumps({**manifest, "version": "0.0.9"}))
        (root / "candidate/candidate-source.json").write_text(json.dumps({
            "sourceSha": "a" * 40, "platform": platform, "module": module,
        }))
        return payload

    def guard(self, root, module, platform, legacy_roster="false"):
        workflow = yaml.safe_load((ROOT / ".github/workflows/qa-modular-packages.yml").read_text())
        guard = next(step["run"] for step in workflow["jobs"]["sign"]["steps"]
                     if step.get("name", "").startswith("Restrict QA signing"))
        source = guard.split("\n", 1)[1].rsplit("\nPY", 1)[0]
        with chdir(root), patch.dict(os.environ, {
            "QA_MODULE": module, "MODULE_PLATFORM": platform, "MODULE_SOURCE_SHA": "a" * 40,
            "MODULE_LEGACY_ROSTER": legacy_roster,
        }):
            exec(compile(source, "trusted-workflow-payload-guard", "exec"), {})

    def test_hello_and_host_only_mfa_match_trusted_contract_on_four_targets(self):
        for module in ["hello-plugin", "mfa"]:
            for platform in PLATFORMS:
                with self.subTest(module=module, platform=platform), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    self.seed(root, module, platform)
                    self.guard(root, module, platform)
                    if module == "hello-plugin":
                        failure = root / "candidate/handshake-failure"
                        manifest = json.loads((failure / "module.json").read_text())
                        self.assertEqual(manifest["version"], "0.1.1")
                        self.assertEqual((failure / manifest["entry"]["host"]).read_bytes(),
                                         (root / "candidate/unsigned-module" / manifest["entry"]["host"]).read_bytes())

    def test_alternate_version_is_limited_to_the_previous_protocol_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.seed(root, "hello-plugin", "linux-x86_64")
            path = root / "candidate/unsigned-previous/module.json"
            manifest = json.loads(path.read_text())
            path.write_text(json.dumps({**manifest, "version": "3.0.0"}))
            with self.assertRaisesRegex(AssertionError, "trusted official contract"):
                self.guard(root, "hello-plugin", "linux-x86_64")

    def test_first_upgrade_roster_requires_the_trusted_mfa_payload(self):
        for platform in PLATFORMS:
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.seed(root, "hello-plugin", platform)
                with self.assertRaises(FileNotFoundError):
                    self.guard(root, "hello-plugin", platform, legacy_roster="true")
                payload = self.seed_payload(root, "mfa", platform, "unsigned-roster-mfa")
                self.guard(root, "hello-plugin", platform, legacy_roster="true")
                manifest = payload / "module.json"
                value = json.loads(manifest.read_text())
                manifest.write_text(json.dumps({**value, "version": "0.0.9"}))
                with self.assertRaisesRegex(AssertionError, "trusted official contract"):
                    self.guard(root, "hello-plugin", platform, legacy_roster="true")

    def test_vnc_key_helper_is_required_on_windows_and_excluded_from_other_packages(self):
        for platform in PLATFORMS:
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                payload = self.seed(root, "vnc-client", platform)
                self.guard(root, "vnc-client", platform)
                helper = payload / "taomni-vnc-key-helper.exe"
                if platform == "windows-x86_64":
                    helper.unlink()
                else:
                    helper.write_bytes(b"unexpected Windows helper")
                with self.assertRaisesRegex(AssertionError, "Unexpected files"):
                    self.guard(root, "vnc-client", platform)

    def test_vnc_only_stages_the_trusted_build_with_matching_renderer_bytes(self):
        stage_frontend = runpy.run_path(str(ROOT / "scripts/stage-vnc-frontend.py"))["stage_frontend"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = self.seed(root, "vnc-client", "linux-x86_64")
            candidate_frontend = payload / "frontend"
            candidate_frontend.mkdir()
            (candidate_frontend / "index.js").write_bytes(b"unexpected candidate frontend")
            with self.assertRaisesRegex(AssertionError, "Unexpected files"):
                self.guard(root, "vnc-client", "linux-x86_64")
            shutil.rmtree(candidate_frontend)
            self.guard(root, "vnc-client", "linux-x86_64")
            trusted = root / "trusted-frontend"
            trusted.mkdir()
            entry = b"export default function Viewer() {}\n"
            (trusted / "index.js").write_bytes(entry)
            (trusted / "receipt.json").write_text(json.dumps({
                "sourceSha": "a" * 40, "toolingSha": "b" * 40, "sha256": hashlib.sha256(entry).hexdigest(),
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "receipt"):
                stage_frontend(trusted, payload, "c" * 40, "b" * 40)
            (trusted / "index.js").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "receipt"):
                stage_frontend(trusted, payload, "a" * 40, "b" * 40)
            (trusted / "index.js").write_bytes(entry)
            stage_frontend(trusted, payload, "a" * 40, "b" * 40)
            self.assertEqual((candidate_frontend / "index.js").read_bytes(), entry)

    def test_source_module_metadata_and_unsigned_file_changes_are_rejected(self):
        for change in ["source", "module", "permissions", "frontend-entry", "extra-file", "frontend-bytes", "secondary-chunk"]:
            module = "hello-plugin" if change in {"frontend-bytes", "secondary-chunk"} else "mfa"
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                payload = self.seed(root, module, "linux-x86_64")
                if change in {"source", "module"}:
                    path = root / "candidate/candidate-source.json"
                    value = json.loads(path.read_text())
                    value["sourceSha" if change == "source" else "module"] = "b" * 40
                else:
                    path = payload / "module.json"
                    value = json.loads(path.read_text())
                    if change == "permissions":
                        value["permissions"].append("network.egress")
                    elif change == "frontend-entry":
                        value["entry"]["frontend"] = "untrusted.js"
                    elif change == "extra-file":
                        (payload / "untrusted.js").write_text("untrusted")
                    elif change == "secondary-chunk":
                        (payload / "frontend/messages.js").write_text("changed relative ESM")
                    else:
                        (payload / "frontend/index.js").write_text("changed official frontend")
                path.write_text(json.dumps(value))
                with self.assertRaises(AssertionError):
                    self.guard(root, module, "linux-x86_64")

    def test_unknown_module_is_rejected_before_candidate_reads(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(AssertionError, "Unknown"):
            self.guard(Path(directory), "../arbitrary", "linux-x86_64")

    @unittest.skipUnless(os.name != "nt", "symlink creation needs no Windows privilege")
    def test_symlinked_host_cannot_enter_the_signed_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = self.seed(root, "mfa", "linux-x86_64")
            host = payload / "taomni-plugin-mfa"
            outside = root / "outside"
            host.rename(outside)
            host.symlink_to(outside)
            with self.assertRaises(AssertionError):
                self.guard(root, "mfa", "linux-x86_64")


if __name__ == "__main__":
    unittest.main()
