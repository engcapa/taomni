"""Pure contracts for the installed-upgrade inputs and registration checks."""
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from installed_desktop_upgrade import require_registration, select_candidate
from modular_bundle_inventory import plan_targets
from qa_ui_auto.legacy_install import windows_install
from qa_ui_auto.legacy_process import observe_same_profile_contender


class InstalledDesktopUpgradeTests(unittest.TestCase):
    old = {"ProductCode": "{bc571798-c76e-41ce-b022-ebdc0c5c33e1}",
           "UpgradeCode": "{cd0d07ef-a2b5-4a17-8d25-434297419ccd}", "InstalledState": 5}
    candidate = {**old, "ProductCode": "{a5e2ebb2-b24a-4a54-ae83-80154c4a8b0e}", "InstalledState": -1}

    def test_requires_only_one_version_from_the_same_registered_msi_family(self):
        require_registration(self.old, self.candidate, upgraded=False)
        upgraded = {**self.candidate, "InstalledState": 5}
        require_registration({**self.old, "InstalledState": -1}, upgraded, upgraded=True)
        for old, candidate, error in [
            (self.old, upgraded, "exactly"),
            (self.old, {**self.candidate, "ProductCode": self.old["ProductCode"]}, "same upgrade family"),
            (self.old, {**self.candidate, "UpgradeCode": self.candidate["ProductCode"]}, "same upgrade family"),
        ]:
            with self.subTest(error=error), self.assertRaisesRegex(RuntimeError, error):
                require_registration(old, candidate, upgraded=False)

    def test_selects_only_the_platform_installer_from_verified_inventory(self):
        root = Path("staged-input")
        files = {"files": [{"name": "taomni.msi"}, {"name": "taomni-setup.exe"}]}
        with patch("installed_desktop_upgrade.inventory", return_value=files):
            self.assertEqual(select_candidate(root, {"target": "windows-x86_64"}), (root / "taomni.msi", files))
            with self.assertRaisesRegex(RuntimeError, "exactly one release .dmg"):
                select_candidate(root, {"target": "darwin-x86_64"})

    def test_desktop_upgrade_matrix_excludes_linux(self):
        plan = plan_targets("all", upgrade_desktop=True)
        self.assertEqual({entry["target"] for entry in plan["include"]},
                         {"windows-x86_64", "darwin-x86_64", "darwin-aarch64"})
        with self.assertRaisesRegex(ValueError, "supported package targets"):
            plan_targets("linux-x86_64", upgrade_desktop=True)

    def test_windows_retries_inspection_after_timeout_with_one_msi_install(self):
        with TemporaryDirectory() as directory:
            destination = Path(directory)
            executable = destination / "taomni.exe"
            executable.touch()
            details = b'{"productVersion":"0.5.10","signatureStatus":"NotSigned"}'
            with patch("qa_ui_auto.legacy_install.subprocess.run", side_effect=[
                subprocess.CompletedProcess([], 0, b"", b""),
                subprocess.TimeoutExpired("powershell.exe", 30, stderr=b"inspection pending"),
                subprocess.CompletedProcess([], 0, details, b""),
            ]) as run:
                installed, observed = windows_install(Path("legacy.msi"), destination, destination)
            self.assertEqual(installed, executable.resolve())
            self.assertEqual(observed["signatureStatus"], "NotSigned")
            installer, query, retry = run.call_args_list
            self.assertEqual(installer.args[0][:2], ["msiexec.exe", "/i"])
            self.assertEqual(query.args[0], retry.args[0])
            self.assertEqual(retry.kwargs["env"]["QA_LEGACY_INSTALLED_EXE"], str(installed))
            timed_out = json.loads((destination / "installed-exe-query.command.json").read_text())
            self.assertIsNone(timed_out["exitCode"])
            self.assertGreater(retry.kwargs["timeout"], timed_out["timeoutSeconds"])
            self.assertEqual((destination / "installed-exe-query.stderr.txt").read_bytes(), b"inspection pending")
            self.assertEqual((destination / "installed-exe.json").read_bytes(), details)

    def test_contender_evidence_records_rejection_and_redacts_pairing_codes(self):
        argv = ["taomni", "--headless", "--data-dir", "same-profile", "--mobile-port", "0"]
        rejected = b"Headless: Close the other Taomni mode using this profile first\n"
        unexpected = b"Mobile endpoint: 127.0.0.1:43210\nPairing code (5 minutes): 123456\n"
        owner_alive = Mock(return_value=True)
        with TemporaryDirectory() as directory:
            evidence = Path(directory)
            with patch("qa_ui_auto.legacy_process.subprocess.run") as run:
                run.return_value = subprocess.CompletedProcess(argv, 1, rejected)
                self.assertEqual(observe_same_profile_contender(argv, owner_alive, evidence, "denied"), {
                    "exitCode": 1, "modeLeaseError": True, "openedEndpoint": False, "ownerStillRunning": True,
                })
                self.assertEqual(run.call_args.args[0], argv)
                run.side_effect = subprocess.TimeoutExpired(argv, 20, output=unexpected)
                self.assertEqual(observe_same_profile_contender(argv, owner_alive, evidence, "opened"), {
                    "exitCode": None, "modeLeaseError": False, "openedEndpoint": True, "ownerStillRunning": True,
                })
            log = (evidence / "opened-contender.log").read_text(encoding="utf-8")
            self.assertIn("[ephemeral pairing code omitted]", log)
            self.assertNotIn("123456", log)
