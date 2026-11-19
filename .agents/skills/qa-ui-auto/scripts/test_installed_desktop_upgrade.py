"""Pure contracts for the installed-upgrade inputs and registration checks."""
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from installed_desktop_upgrade import require_registration, select_candidate
from modular_bundle_inventory import plan_targets
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

    def test_contender_evidence_records_rejection_and_redacts_pairing_codes(self):
        argv = ["taomni", "--headless", "--data-dir", "same-profile", "--mobile-port", "0"]
        rejected = b"Headless: Close the other Taomni mode using this profile first\n"
        unexpected = b"Mobile endpoint: 127.0.0.1:43210\nPairing code (5 minutes): 123456\n"
        owner = Mock()
        owner.poll.return_value = None
        with TemporaryDirectory() as directory:
            evidence = Path(directory)
            with patch("qa_ui_auto.legacy_process.subprocess.run") as run:
                run.return_value = subprocess.CompletedProcess(argv, 1, rejected)
                self.assertEqual(observe_same_profile_contender(argv, owner, evidence, "denied"), {
                    "exitCode": 1, "modeLeaseError": True, "openedEndpoint": False, "ownerStillRunning": True,
                })
                self.assertEqual(run.call_args.args[0], argv)
                run.side_effect = subprocess.TimeoutExpired(argv, 20, output=unexpected)
                self.assertEqual(observe_same_profile_contender(argv, owner, evidence, "opened"), {
                    "exitCode": None, "modeLeaseError": False, "openedEndpoint": True, "ownerStillRunning": True,
                })
            log = (evidence / "opened-contender.log").read_text(encoding="utf-8")
            self.assertIn("[ephemeral pairing code omitted]", log)
            self.assertNotIn("123456", log)
