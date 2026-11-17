"""Validate package runner admission without launching a host or signing code."""
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

    def admit(self, label, output):
        with patch.dict(os.environ, {"PACKAGE_MACOS_RUNNER": label, "GITHUB_OUTPUT": str(output)}):
            exec(compile(self.guard, "trusted-package-runner-admission", "exec"), {})

    def test_available_hosted_images_emit_one_validated_output(self):
        for label in ("macos-latest", "macos-15", "macos-15-intel", "macos-26"):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "github-output"
                output.write_text("source=already-preserved\n")
                self.admit(label, output)
                self.assertEqual(output.read_text(), f"source=already-preserved\nrunner={label}\n")

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
        self.assertEqual({entry["platform"]: entry["target"] for entry in jobs["build"]["strategy"]["matrix"]["include"]}, {
            "linux-x86_64": "x86_64-unknown-linux-gnu",
            "windows-x86_64": "x86_64-pc-windows-msvc",
            "darwin-aarch64": "aarch64-apple-darwin",
            "darwin-x86_64": "x86_64-apple-darwin",
        })
        caller = yaml.safe_load((ROOT / ".github/workflows/qa-ui-auto-platforms.yml").read_text())
        self.assertEqual(caller["jobs"]["signed-modular-packages"]["with"]["macos_runner"],
                         "${{ inputs.macos_runner || 'macos-15' }}")


if __name__ == "__main__":
    unittest.main()
