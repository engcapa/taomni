"""Execute the workflow's inert-payload guard without keys or host processes."""
from contextlib import chdir
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml

from qa_ui_auto.module_qa_versions import lifecycle_versions

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
        if module == "sockscap":
            xray = Path("resources/xray")
            pinned = trusted / xray
            pinned.mkdir(parents=True)
            (payload / xray).mkdir(parents=True)
            binary = "xray.exe" if platform.startswith("windows-") else "xray"
            (payload / xray / binary).write_bytes(b"inert Xray")
            (payload / xray / "LICENSE").write_bytes(b"Xray license")
            (pinned / "release.json").write_text(json.dumps({
                "licenseSha256": hashlib.sha256(b"Xray license").hexdigest(),
                "platforms": {platform: {"binarySha256": hashlib.sha256(b"inert Xray").hexdigest()}},
            }))
            if platform == "windows-x86_64":
                capture = Path("resources/windows")
                (trusted / capture).mkdir(parents=True)
                (payload / capture).mkdir(parents=True)
                assets = {"WinDivert.dll": b"DLL", "WinDivert64.sys": b"SYS", "LICENSE": b"license"}
                for name, content in assets.items():
                    (payload / capture / name).write_bytes(content)
                (payload / capture / "sockscap-helper.exe").write_bytes(b"MZ inert unit helper")
                (trusted / capture / "windivert-release.json").write_text(json.dumps({
                    "files": {name: {"sha256": hashlib.sha256(content).hexdigest()}
                              for name, content in assets.items()},
                }))
            elif platform == "linux-x86_64":
                linux_capture = Path("resources/linux")
                (payload / linux_capture).mkdir(parents=True)
                (payload / linux_capture / "taomni-sockscap-trace-launcher").write_bytes(b"\x7fELF inert unit launcher")
        frontend = manifest["entry"].get("frontend")
        if frontend and module not in {"vnc-client", "rdp-client", "mail", "mfa", "screenshot", "sockscap",
                                       "rdp-server", "vnc-server", "servers"}:
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

    def guard(self, root, module, platform, legacy_roster="false", lifecycle="false"):
        workflow = yaml.safe_load((ROOT / ".github/workflows/qa-modular-packages.yml").read_text())
        guard = next(step["run"] for step in workflow["jobs"]["sign"]["steps"]
                     if step.get("name", "").startswith("Restrict QA signing"))
        source = guard.split("\n", 1)[1].rsplit("\nPY", 1)[0]
        scripts = root / "scripts"
        scripts.mkdir(exist_ok=True)
        for helper in ("local_voice_runtime.py", "sockscap_linux_resource.py", "sockscap_redirector_resource.py",
                       "sockscap_windows_resource.py", "sockscap_xray_resource.py"):
            shutil.copyfile(ROOT / "scripts" / helper, scripts / helper)
        with chdir(root), patch.object(sys, "path", list(sys.path)), patch.dict(os.environ, {
            "QA_MODULE": module, "MODULE_PLATFORM": platform, "MODULE_SOURCE_SHA": "a" * 40,
            "MODULE_LEGACY_ROSTER": legacy_roster, "MODULE_LIFECYCLE": lifecycle,
        }):
            exec(compile(source, "trusted-workflow-payload-guard", "exec"), {})

    def seed_macos_redirector(self, root, payload):
        resource = Path("resources/macos/redirector/0.12.11")
        trusted = root / "src-tauri/plugins/sockscap" / resource
        trusted.mkdir(parents=True)
        archive = b"inert test archive"
        (trusted / "manifest.json").write_text(json.dumps({"appTarSha256": hashlib.sha256(archive).hexdigest()}))
        (trusted / "LICENSE").write_text("fixture license")
        shutil.copytree(trusted, payload / resource)
        target = payload / resource / "Mitmproxy Redirector.app.tar"
        target.write_bytes(archive)
        return target, archive

    def test_macos_sockscap_requires_the_exact_pinned_installer(self):
        for platform in ("darwin-aarch64", "darwin-x86_64"):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                payload = self.seed(root, "sockscap", platform)
                target, archive = self.seed_macos_redirector(root, payload)
                self.guard(root, "sockscap", platform)
                target.write_bytes(archive + b"altered")
                with self.assertRaisesRegex(ValueError, "differs from the pinned release"):
                    self.guard(root, "sockscap", platform)

    def test_sockscap_rejects_changed_windows_driver_and_xray_before_signing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            platform = "windows-x86_64"
            payload = self.seed(root, "sockscap", platform)
            self.guard(root, "sockscap", platform)
            driver = payload / "resources/windows/WinDivert64.sys"
            original = driver.read_bytes()
            driver.write_bytes(b"altered")
            with self.assertRaisesRegex(ValueError, "WinDivert64.sys differs"):
                self.guard(root, "sockscap", platform)
            driver.write_bytes(original)
            (payload / "resources/xray/xray.exe").write_bytes(b"altered")
            with self.assertRaisesRegex(ValueError, "Xray xray.exe differs"):
                self.guard(root, "sockscap", platform)

    def test_linux_sockscap_requires_verified_elf_launcher_and_excludes_other_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = self.seed(root, "sockscap", "linux-x86_64")
            self.guard(root, "sockscap", "linux-x86_64")
            launcher = payload / "resources/linux/taomni-sockscap-trace-launcher"
            original = launcher.read_bytes()
            launcher.write_bytes(b"not-elf")
            with self.assertRaisesRegex(ValueError, "not an ELF executable"):
                self.guard(root, "sockscap", "linux-x86_64")
            launcher.write_bytes(original)
            (payload / "resources/linux/extra").write_bytes(b"extra")
            with self.assertRaisesRegex(ValueError, "Unexpected or missing"):
                self.guard(root, "sockscap", "linux-x86_64")
            launcher.unlink()
            (payload / "resources/linux/extra").unlink()
            with self.assertRaisesRegex(ValueError, "Unexpected or missing"):
                self.guard(root, "sockscap", "linux-x86_64")

        for platform in ("windows-x86_64", "darwin-aarch64", "darwin-x86_64"):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                payload = self.seed(root, "sockscap", platform)
                if platform.startswith("darwin-"):
                    self.seed_macos_redirector(root, payload)
                (payload / "resources/linux").mkdir(parents=True, exist_ok=True)
                (payload / "resources/linux/taomni-sockscap-trace-launcher").write_bytes(b"\x7fELF unexpected")
                with self.assertRaisesRegex(ValueError, "Unexpected Linux"):
                    self.guard(root, "sockscap", platform)

    def test_local_voice_requires_its_windows_runtime_in_the_signed_payload(self):
        runtime = runpy.run_path(str(ROOT / "scripts/local_voice_runtime.py"))["WINDOWS_RUNTIME"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = self.seed(root, "ai-voice-local", "windows-x86_64")
            for name in runtime:
                (payload / name).write_bytes(b"inert runtime library")
            self.guard(root, "ai-voice-local", "windows-x86_64")
            (payload / runtime[0]).unlink()
            with self.assertRaisesRegex(ValueError, "Missing Local Voice runtime library"):
                self.guard(root, "ai-voice-local", "windows-x86_64")

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

    def test_business_lifecycle_requires_distinct_previous_host_bytes_and_fixed_version(self):
        runtime = runpy.run_path(str(ROOT / "scripts/local_voice_runtime.py"))["WINDOWS_RUNTIME"]
        for module in ("mfa", "servers", "sockscap", "screenshot", "ai-voice-local", "mail"):
            for platform in PLATFORMS:
                with self.subTest(module=module, platform=platform), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    current = self.seed(root, module, platform)
                    if module == "sockscap" and platform.startswith("darwin-"):
                        self.seed_macos_redirector(root, current)
                    if module == "ai-voice-local" and platform == "windows-x86_64":
                        for name in runtime:
                            (current / name).write_bytes(b"inert runtime library")
                    manifest = json.loads((current / "module.json").read_text())
                    host_name = manifest["entry"]["host"]
                    previous_version, failed_version = lifecycle_versions(module, manifest["version"])
                    previous = root / "candidate/unsigned-previous"
                    shutil.copytree(current, previous)
                    previous_manifest = previous / "module.json"
                    previous_manifest.write_text(json.dumps({**manifest, "version": previous_version}))
                    with self.assertRaisesRegex(AssertionError, "independently compiled"):
                        self.guard(root, module, platform, lifecycle="true")
                    (previous / host_name).write_bytes(f"distinct older {module} host fixture".encode())
                    previous_manifest.write_text(json.dumps({**manifest, "version": "3.0.0"}))
                    with self.assertRaisesRegex(AssertionError, "trusted official contract"):
                        self.guard(root, module, platform, lifecycle="true")
                    previous_manifest.write_text(json.dumps({**manifest, "version": previous_version}))
                    self.guard(root, module, platform, lifecycle="true")
                    failure = root / "candidate/handshake-failure"
                    self.assertEqual(json.loads((failure / "module.json").read_text())["version"], failed_version)
                    self.assertEqual((failure / host_name).read_bytes(), (current / host_name).read_bytes())

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
                "sourceSha": "a" * 40, "toolingSha": "b" * 40, "slug": "vnc-client",
                "sha256": hashlib.sha256(entry).hexdigest(),
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "receipt"):
                stage_frontend(trusted, payload, "c" * 40, "b" * 40, "vnc-client")
            with self.assertRaisesRegex(ValueError, "receipt"):
                stage_frontend(trusted, payload, "a" * 40, "b" * 40, "rdp-client")
            (trusted / "index.js").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "receipt"):
                stage_frontend(trusted, payload, "a" * 40, "b" * 40, "vnc-client")
            (trusted / "index.js").write_bytes(entry)
            stage_frontend(trusted, payload, "a" * 40, "b" * 40, "vnc-client")
            self.assertEqual((candidate_frontend / "index.js").read_bytes(), entry)

    def test_official_panels_stage_only_the_matching_trusted_renderer(self):
        stage_frontend = runpy.run_path(str(ROOT / "scripts/stage-vnc-frontend.py"))["stage_frontend"]
        for slug in ("mail", "mfa", "sockscap", "rdp-server", "vnc-server", "servers"):
            with self.subTest(slug=slug), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                payload = self.seed(root, slug, "linux-x86_64")
                self.guard(root, slug, "linux-x86_64")
                trusted = root / "trusted-frontend"
                trusted.mkdir()
                entry = b"export default function Panel() {}\n"
                (trusted / "index.js").write_bytes(entry)
                receipt = {"sourceSha": "a" * 40, "toolingSha": "b" * 40, "slug": slug,
                           "sha256": hashlib.sha256(entry).hexdigest()}
                (trusted / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "receipt"):
                    stage_frontend(trusted, payload, "a" * 40, "d" * 40, slug)
                stage_frontend(trusted, payload, "a" * 40, "b" * 40, slug)
                self.assertEqual((payload / "frontend/index.js").read_bytes(), entry)
                with self.assertRaisesRegex(AssertionError, "Unexpected files"):
                    self.guard(root, slug, "linux-x86_64")

    def test_screenshot_rejects_changed_trained_data_before_signing(self):
        helpers = runpy.run_path(str(ROOT / "scripts/stage-vnc-frontend.py"))
        source, tooling, slug = "a" * 40, "b" * 40, "screenshot"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = self.seed(root, slug, "linux-x86_64")
            self.guard(root, slug, "linux-x86_64")
            trusted = root / "trusted-frontend"
            assets = trusted / "screenshot-ocr"
            assets.mkdir(parents=True)
            (trusted / "index.js").write_bytes(b"export const fixture = true;")
            (trusted / "recorder.js").write_bytes(b"export const RecorderBar = () => null;")
            for name in helpers["SCREENSHOT_ASSETS"]:
                (assets / name).write_bytes(name.encode())
            files = helpers["frontend_files"](trusted, slug, with_receipt=False)
            receipt = helpers["frontend_receipt"](files, source, tooling, slug)
            (trusted / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
            changed = assets / "eng.traineddata.gz"
            changed.write_bytes(b"changed while staging")
            with self.assertRaisesRegex(ValueError, "receipt"):
                helpers["stage_frontend"](trusted, payload, source, tooling, slug)
            self.assertFalse((payload / "frontend").exists())
            changed.write_bytes(changed.name.encode())
            helpers["stage_frontend"](trusted, payload, source, tooling, slug)
            self.assertEqual((payload / "frontend/screenshot-ocr/eng.traineddata.gz").read_bytes(), changed.read_bytes())

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
