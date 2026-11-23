"""Validate package runner admission without launching a host or signing code."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[4]


class OfficialPackageRunnerTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load((ROOT / ".github/workflows/qa-modular-packages.yml").read_text())
        step = next(step for step in self.workflow["jobs"]["source"]["steps"]
                    if step.get("id") == "macos_runner")
        self.guard = step["run"].split("\n", 1)[1].rsplit("\nPY", 1)[0]

    def admit(self, label, output, native_builds="", module="hello-plugin"):
        with patch.dict(os.environ, {"PACKAGE_MACOS_RUNNER": label, "GITHUB_OUTPUT": str(output),
                                    "PACKAGE_NATIVE_BUILDS": native_builds, "QA_MODULE": module,
                                    "PACKAGE_ARTIFACT_KEY": "test-vnc"}):
            exec(compile(self.guard, "trusted-package-runner-admission", "exec"), {})
        return dict(line.split("=", 1) for line in output.read_text().splitlines())

    def roster_targets(self, values, matrix):
        return {entry["platform"]: entry["legacy_roster"] for entry in json.loads(values[matrix])["include"]}

    def test_available_hosted_images_emit_one_validated_output(self):
        for label in ("macos-latest", "macos-15", "macos-15-intel", "macos-26"):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "github-output"
                output.write_text("source=already-preserved\n")
                values = self.admit(label, output)
                self.assertEqual(values["source"], "already-preserved")
                self.assertEqual(values["runner"], label)
                self.assertEqual(len(output.read_text().splitlines()), 4)

    def test_unknown_hosts_and_output_injection_fail_before_writing(self):
        for label in ("", "self-hosted", "ubuntu-24.04", "macos-26\nrunner=self-hosted", "macos-26 "):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "github-output"
                output.write_text("source=already-preserved\n")
                with self.assertRaisesRegex(SystemExit, "Unknown hosted"):
                    self.admit(label, output)
                self.assertEqual(output.read_text(), "source=already-preserved\n")

    def test_scheduler_consumes_validated_label_and_preserves_all_target_architectures(self):
        jobs = self.workflow["jobs"]
        self.assertEqual(jobs["source"]["outputs"]["macos_runner"], "${{ steps.macos_runner.outputs.runner }}")
        self.assertIn("needs.source.outputs.macos_runner", jobs["build"]["runs-on"])
        self.assertNotIn("inputs.macos_runner", jobs["build"]["runs-on"])
        with tempfile.TemporaryDirectory() as directory:
            values = self.admit("macos-26", Path(directory) / "output")
        targets = json.loads(values["build_matrix"])["include"]
        self.assertEqual({entry["platform"]: entry["target"] for entry in targets}, {
            "linux-x86_64": "x86_64-unknown-linux-gnu",
            "windows-x86_64": "x86_64-pc-windows-msvc",
            "darwin-aarch64": "aarch64-apple-darwin",
            "darwin-x86_64": "x86_64-apple-darwin",
        })
        caller = yaml.safe_load((ROOT / ".github/workflows/qa-ui-auto-platforms.yml").read_text())
        self.assertEqual(caller["jobs"]["signed-modular-packages"]["with"]["macos_runner"],
                         "${{ inputs.macos_runner || 'macos-15' }}")
        self.assertEqual(caller["jobs"]["signed-modular-packages"]["with"]["native_builds"],
                         "${{ needs.plan.outputs.build_matrix }}")
        self.assertEqual(jobs["build"]["strategy"]["matrix"], "${{ fromJSON(needs.source.outputs.build_matrix) }}")
        self.assertEqual(jobs["sign"]["strategy"]["matrix"], "${{ fromJSON(needs.source.outputs.sign_matrix) }}")
        self.assertEqual(self.roster_targets(values, "sign_matrix"), {target["platform"]: False for target in targets})

    def test_focused_targets_dedupe_profiles_and_keep_macos_architectures_separate(self):
        for platforms, expected in [
            ([("linux", "X64"), ("windows", "X64"), ("linux", "X64")], {"linux-x86_64", "windows-x86_64"}),
            ([("macos", "X64")], {"darwin-x86_64"}),
            ([("macos", "ARM64")], {"darwin-aarch64"}),
        ]:
            builds = {"include": [{"platform_key": platform, "arch": arch, "capabilities": ["signed-module"]}
                                   for platform, arch in platforms]}
            with self.subTest(platforms=platforms), tempfile.TemporaryDirectory() as directory:
                values = self.admit("macos-15-intel", Path(directory) / "output", json.dumps(builds))
                self.assertEqual({target["platform"] for target in json.loads(values["build_matrix"])["include"]}, expected)
                self.assertEqual(self.roster_targets(values, "sign_matrix"), dict.fromkeys(expected, False))

    def test_roster_builds_and_signs_both_modules_on_the_requested_platform(self):
        builds = {"include": [
            {"platform_key": "linux", "arch": "X64", "capabilities": ["signed-module"]},
            {"platform_key": "macos", "arch": "ARM64", "capabilities": ["signed-module", "signed-roster"]},
            {"platform_key": "macos", "arch": "X64", "capabilities": ["signed-module"]},
        ]}
        expected = {"linux-x86_64": False, "darwin-aarch64": True, "darwin-x86_64": False}
        with tempfile.TemporaryDirectory() as directory:
            values = self.admit("macos-26", Path(directory) / "output", json.dumps(builds))
        self.assertEqual(self.roster_targets(values, "build_matrix"), expected)
        self.assertEqual(self.roster_targets(values, "sign_matrix"), expected)

    def test_unknown_or_empty_target_selection_cannot_publish_outputs(self):
        for builds in [[], {}, {"include": []}, {"include": [None]},
                       {"include": [{"platform_key": "linux", "arch": "ARM64", "capabilities": ["signed-module"]}]},
                       {"include": [{"platform_key": "macos", "arch": "X64", "capabilities": []}]}]:
            with self.subTest(builds=builds), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "output"
                with self.assertRaises(SystemExit):
                    self.admit("macos-26", output, json.dumps(builds))
                self.assertFalse(output.exists())

    def test_mfa_selects_only_builds_that_need_its_signed_package(self):
        builds = {"include": [
            {"platform_key": "linux", "arch": "X64", "capabilities": ["signed-module"]},
            {"platform_key": "macos", "arch": "X64", "capabilities": ["signed-module"]},
            {"platform_key": "macos", "arch": "ARM64", "capabilities": ["signed-mfa"]},
        ]}
        with tempfile.TemporaryDirectory() as directory:
            values = self.admit("macos-26", Path(directory) / "output", json.dumps(builds), "mfa")
        self.assertEqual(json.loads(values["build_matrix"])["include"][0]["target"], "aarch64-apple-darwin")
        self.assertEqual(self.roster_targets(values, "sign_matrix"), {"darwin-aarch64": False})

    def test_mfa_lifecycle_build_is_limited_to_selected_runner_platforms(self):
        builds = {"include": [
            {"platform_key": "linux", "arch": "X64", "capabilities": ["signed-mfa"]},
            {"platform_key": "macos", "arch": "ARM64", "capabilities": ["signed-mfa", "signed-mfa-lifecycle"]},
        ]}
        with tempfile.TemporaryDirectory() as directory:
            values = self.admit("macos-26", Path(directory) / "output", json.dumps(builds), "mfa")
        expected = {"linux-x86_64": False, "darwin-aarch64": True}
        for matrix in ("build_matrix", "sign_matrix"):
            self.assertEqual({entry["platform"]: entry["lifecycle"]
                              for entry in json.loads(values[matrix])["include"]}, expected)

    def test_server_module_frontends_follow_their_own_package_targets(self):
        builds = {"include": [
            {"platform_key": "linux", "arch": "X64", "capabilities": ["signed-local-vnc"]},
            {"platform_key": "windows", "arch": "X64", "capabilities": ["signed-vnc", "signed-local-rdp"]},
            {"platform_key": "macos", "arch": "ARM64", "capabilities": ["signed-local-servers"]},
        ]}
        for slug, platform in (("vnc-server", "linux-x86_64"),
                               ("rdp-server", "windows-x86_64"),
                               ("servers", "darwin-aarch64")):
            with self.subTest(slug=slug), tempfile.TemporaryDirectory() as directory:
                values = self.admit("macos-26", Path(directory) / "output", json.dumps(builds), slug)
                self.assertEqual(self.roster_targets(values, "sign_matrix"), {platform: False})
                self.assertEqual(values["frontend_artifact"], f"qa-{slug}-frontend-test-vnc-{platform}")

    def test_parallel_desktop_client_builds_use_distinct_frontend_artifacts(self):
        for client in ("vnc", "rdp"):
            for platform, arch, target in [("linux", "X64", "linux-x86_64"),
                                           ("windows", "X64", "windows-x86_64"),
                                           ("macos", "ARM64", "darwin-aarch64")]:
                builds = {"include": [{"platform_key": platform, "arch": arch, "capabilities": [f"signed-{client}"]}]}
                with self.subTest(client=client, target=target), tempfile.TemporaryDirectory() as directory:
                    slug = f"{client}-client"
                    values = self.admit("macos-26", Path(directory) / "output", json.dumps(builds), slug)
                    self.assertEqual(values["frontend_artifact"], f"qa-{slug}-frontend-test-vnc-{target}")


if __name__ == "__main__":
    unittest.main()
