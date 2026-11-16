"""Execute the workflow's inert-payload guard without keys or host processes."""
from contextlib import chdir
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[4]
PLATFORMS = ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"]


class OfficialPackageSigningGuardTests(unittest.TestCase):
    def seed(self, root, module, platform):
        trusted = root / "src-tauri/plugins" / module
        trusted.mkdir(parents=True)
        shutil.copyfile(ROOT / "src-tauri/plugins" / module / "module.json", trusted / "module.json")
        manifest = json.loads((trusted / "module.json").read_text())
        payload = root / "candidate/unsigned-module"
        payload.mkdir(parents=True)
        if platform.startswith("windows"):
            manifest["entry"]["host"] += ".exe"
        (payload / manifest["entry"]["host"]).write_bytes(b"inert unit host; never executed")
        frontend = manifest["entry"].get("frontend")
        if frontend:
            shutil.copytree(ROOT / "src-tauri/plugins" / module / "frontend", trusted / "frontend")
            shutil.copytree(trusted / "frontend", payload / "frontend")
        (payload / "module.json").write_text(json.dumps(manifest))
        (root / "candidate/candidate-source.json").write_text(json.dumps({
            "sourceSha": "a" * 40, "platform": platform, "module": module,
        }))
        return payload

    def guard(self, root, module, platform):
        workflow = yaml.safe_load((ROOT / ".github/workflows/qa-modular-packages.yml").read_text())
        guard = next(step["run"] for step in workflow["jobs"]["sign"]["steps"]
                     if step.get("name", "").startswith("Restrict QA signing"))
        source = guard.split("\n", 1)[1].rsplit("\nPY", 1)[0]
        with chdir(root), patch.dict(os.environ, {
            "QA_MODULE": module, "MODULE_PLATFORM": platform, "MODULE_SOURCE_SHA": "a" * 40,
        }):
            exec(compile(source, "trusted-workflow-payload-guard", "exec"), {})

    def test_hello_and_host_only_mfa_match_trusted_contract_on_four_targets(self):
        for module in ["hello-plugin", "mfa"]:
            for platform in PLATFORMS:
                with self.subTest(module=module, platform=platform), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    self.seed(root, module, platform)
                    self.guard(root, module, platform)

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
