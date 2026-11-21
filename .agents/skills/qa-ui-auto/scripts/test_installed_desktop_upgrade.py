"""Pure contracts for the installed-upgrade inputs and registration checks."""
from contextlib import nullcontext
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

from installed_desktop_mode_lease import check_mode_lease, reserve_default_profile
from installed_desktop_mfa_crash import observe_abrupt_exit
from installed_desktop_upgrade import require_registration, select_candidate
from installed_macos_host_signature import require_hardened_signature
from installed_macos_permissions import compare_permissions, observe_hosted_screen_scan
from installed_windows_mfa import verify_mfa_controls
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


class InstalledHardenedSignatureTests(unittest.TestCase):
    def test_requires_pinned_leaf_and_hardened_code_directory(self):
        leaf = b"fixed-certificate"
        fingerprint = hashlib.sha1(leaf, usedforsecurity=False).hexdigest().upper()
        details = "Executable=/Applications/Taomni.app\nCodeDirectory v=20500 size=320 flags=0x10000(runtime) hashes=5+3\n"
        self.assertEqual(require_hardened_signature(details, leaf, fingerprint), {
            "certificateSha1": fingerprint, "hardenedRuntime": True,
        })
        with self.assertRaisesRegex(RuntimeError, "different leaf certificate"):
            require_hardened_signature(details, b"different-certificate", fingerprint)
        for invalid in [
            details.replace("0x10000(runtime)", "0x0(none)"),
            details + "Signature=adhoc\n",
            "Executable=/fake flags=0x10000(runtime)\n",
        ]:
            with self.subTest(invalid=invalid), self.assertRaisesRegex(RuntimeError, "hardened runtime"):
                require_hardened_signature(invalid, leaf, fingerprint)


class InstalledDesktopModeLeaseTests(unittest.TestCase):
    hosted = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": "engcapa/taomni"}

    def test_never_reuses_a_production_profile_that_already_exists(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "Library" / "Application Support"
            data.mkdir(parents=True)
            evidence = root / "evidence"
            evidence.mkdir()
            with patch.dict("os.environ", self.hosted), patch(
                "installed_desktop_mode_lease.platform.system", return_value="Darwin",
            ), patch("installed_desktop_mode_lease.Path.home", return_value=root):
                profile = reserve_default_profile(evidence)
                original = profile / "taomni.db"
                original.write_bytes(b"recorded state")
                with self.assertRaises(FileExistsError):
                    reserve_default_profile(evidence)
                self.assertEqual(original.read_bytes(), b"recorded state")
                self.assertEqual(profile, data.resolve() / "com.taomni.app")

    def test_relaunches_same_installed_binary_in_both_modes(self):
        denied = {"exitCode": 1, "modeLeaseError": True, "openedEndpoint": False, "ownerStillRunning": True}
        generation = "6bb4a236-8790-45b5-b74a-eeb997387abc"
        desktop = MagicMock(pid=17, returncode=None)
        desktop.poll.return_value = None
        desktop.__enter__.return_value = desktop
        desktop.wait.return_value = 1
        headless = Mock()
        headless.poll.return_value = None
        with TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "taomni"
            executable.touch()
            profile = root / "com.taomni.app"

            def initialize(binary, data, work, evidence, label, *, observe_ready):
                self.assertEqual((binary, data), (executable, profile))
                desktop.kill.assert_called_once()
                observe_ready(headless)
                return {"ready": True, "exited": True}

            with patch("installed_desktop_mode_lease.reserve_default_profile", return_value=profile), patch(
                "installed_desktop_mode_lease.subprocess.Popen", return_value=desktop,
            ), patch("installed_desktop_mode_lease.wait_for_generation", return_value=generation), patch(
                "installed_desktop_mode_lease.read_generation", return_value=generation,
            ), patch("installed_desktop_mode_lease.initialize_profile", side_effect=initialize), patch(
                "installed_desktop_mode_lease.observe_same_profile_contender", return_value=denied,
            ) as contenders:
                receipt = check_mode_lease(executable, root, root)
            self.assertTrue(receipt["passed"])
            self.assertEqual(receipt["generation"], generation)
            self.assertEqual(receipt["headlessContender"], denied)
            self.assertEqual(receipt["desktopContender"], denied)
            first, second = contenders.call_args_list
            self.assertEqual(first.args[0][:4], [str(executable), "--headless", "--data-dir", str(profile)])
            self.assertEqual(second.args[0], [str(executable)])


class InstalledDesktopMfaCrashTests(unittest.TestCase):
    def test_kills_only_the_owned_application_and_waits_for_the_signed_host(self):
        for host_survives in (False, True):
            with self.subTest(host_survives=host_survives), TemporaryDirectory() as temporary:
                timeout = TimeoutError("host survived")
                application = Path(temporary).resolve() / "installed-taomni.exe"
                module = application.with_name("installed-mfa-module.exe")
                application.touch()
                launcher = Mock(pid=21, args=[str(application)])
                launcher.poll.return_value = None
                launcher.wait.return_value = 1
                core = Mock(pid=21)
                host = Mock(pid=23)
                host.exe.return_value = str(module)
                core.children.return_value = [host]
                host.wait.side_effect = timeout if host_survives else None
                observer = SimpleNamespace(Process=Mock(return_value=core),
                                           NoSuchProcess=ProcessLookupError, AccessDenied=PermissionError)
                result = {}
                with patch.dict(sys.modules, {"psutil": observer}), patch(
                    "installed_desktop_mfa_crash.platform.system", return_value="Windows",
                ):
                    if host_survives:
                        with self.assertRaisesRegex(TimeoutError, "host survived"):
                            observe_abrupt_exit(launcher, application, module, result)
                    else:
                        observe_abrupt_exit(launcher, application, module, result)
                self.assertNotEqual(host_survives, result.get("hostExitedBeforeDriverCleanup", False))
                self.assertTrue(result["coreExited"])
                self.assertEqual(result["coreIdentity"], "owned-windows-launch")
                self.assertEqual(result["termination"], "TerminateProcess")
                core.kill.assert_not_called()
                host.kill.assert_not_called()
                launcher.kill.assert_called_once_with()

    def test_windows_mfa_requires_the_owned_pid_and_updated_hotp(self):
        owner = Mock(pid=21)
        owner.poll.return_value = None
        cases = [(21, ["287082", "359152"], True), (22, ["287082", "359152"], False),
                 (21, ["287082", "287082"], False)]
        for pid, codes, expected in cases:
            with self.subTest(pid=pid, codes=codes), TemporaryDirectory() as directory:
                report = Path(directory)
                output = json.dumps({"phase": "after", "ownerPid": pid, "codes": codes})
                completed = subprocess.CompletedProcess([], 0, stdout=output, stderr="")
                with patch("installed_windows_mfa.subprocess.run", return_value=completed) as run:
                    if expected:
                        verify_mfa_controls(owner, "after", report)
                    else:
                        with self.assertRaisesRegex(RuntimeError, "expected HOTP values"):
                            verify_mfa_controls(owner, "after", report)
                    self.assertEqual(run.call_args.args[0][-4:], ["-OwnerId", "21", "-Phase", "after"])
                    self.assertTrue(json.loads(run.call_args.kwargs["input"])["uri"].startswith("otpauth://hotp/"))
                receipt = json.loads((report / "windows-mfa-after.json").read_text(encoding="utf-8"))
                self.assertEqual(receipt["passed"], expected)

    def test_windows_mfa_failure_keeps_script_location_without_raw_output(self):
        owner = Mock(pid=21)
        cases = [
            ('{"exception":"System.InvalidOperationException","hresult":-2146233079,"line":52,"stage":"open-mfa"}',
             "System.InvalidOperationException, HRESULT 0x80131509, script line 52, stage open-mfa"),
            ('Sensitive WebView or fixture output', "PowerShell exit 1"),
        ]
        for stderr, expected in cases:
            with self.subTest(expected=expected), TemporaryDirectory() as directory:
                report = Path(directory)
                completed = subprocess.CompletedProcess([], 1, stdout="", stderr=stderr)
                with patch("installed_windows_mfa.subprocess.run", return_value=completed):
                    with self.assertRaisesRegex(RuntimeError, expected):
                        verify_mfa_controls(owner, "seed", report)
                receipt = json.loads((report / "windows-mfa-seed.json").read_text(encoding="utf-8"))
                self.assertFalse(receipt["passed"])
                self.assertEqual(receipt["error"], expected)

    def test_windows_mfa_failure_keeps_only_safe_control_observations(self):
        controls = {"visiblePasswordFields": 0, "mfaActionVisible": True, "addAccountVisible": False}
        diagnostic = {"exception": "System.InvalidOperationException", "hresult": -2146233079,
                      "line": 80, "stage": "vault-setup-fields", "controls": {**controls, "unknown": "redact"}}
        failed = subprocess.CompletedProcess([], 1, stdout="", stderr=json.dumps(diagnostic))
        with TemporaryDirectory() as directory:
            report = Path(directory)
            with patch("installed_windows_mfa.subprocess.run", return_value=failed):
                with self.assertRaisesRegex(RuntimeError, "stage vault-setup-fields"):
                    verify_mfa_controls(Mock(pid=21), "seed", report)
            receipt = json.loads((report / "windows-mfa-seed.json").read_text(encoding="utf-8"))
            self.assertEqual(receipt["controls"], controls)

    def test_macos_uses_the_owned_bridge_and_matches_a_hardened_child_command(self):
        with TemporaryDirectory() as temporary:
            application = Path(temporary).resolve() / "Taomni"
            module = application.with_name("taomni-plugin-mfa")
            application.touch()
            module.touch()
            launcher = Mock(pid=21, args=[str(application)])
            launcher.poll.return_value = None
            launcher.wait.return_value = -9
            core = Mock(pid=21)
            host = Mock(pid=22)
            host.exe.side_effect = PermissionError("hardened executable")
            host.cmdline.return_value = [str(module)]
            core.children.return_value = [host]
            observer = SimpleNamespace(Process=Mock(return_value=core),
                                       NoSuchProcess=ProcessLookupError, AccessDenied=PermissionError)
            result = {}
            with patch.dict(sys.modules, {"psutil": observer}), patch(
                "installed_desktop_mfa_crash.platform.system", return_value="Darwin",
            ):
                observe_abrupt_exit(launcher, application, module, result)
            self.assertEqual(result["coreIdentity"], "owned-wkwebview-launch")
            self.assertEqual(result["host"]["pid"], host.pid)
            self.assertTrue(result["hostExitedBeforeDriverCleanup"])
            launcher.kill.assert_called_once_with()
            core.kill.assert_not_called()
            host.kill.assert_not_called()


class InstalledMacPermissionsTests(unittest.TestCase):
    def test_failed_capture_closes_the_fixture_and_records_incomplete_evidence(self):
        recovery = dict(sourceSha="source", installedBinarySha256="core", modulePackageSha256="package",
                        moduleBinarySha256="host", nextHotp="359 152")
        steps = object()

        def desktop_action(_steps, verb, args):
            if verb == "wait_for":
                raise RuntimeError("capture did not produce an import preview")

        with TemporaryDirectory() as directory:
            evidence = Path(directory)
            (evidence / "native-image-window.json").write_text('{"pid": 42}', encoding="utf-8")
            desktop = nullcontext((SimpleNamespace(proc=SimpleNamespace(pid=17)), object()))
            with patch("installed_macos_permissions.installed_desktop", return_value=desktop), patch(
                "installed_macos_permissions.open_unlocked_mfa", return_value=steps,
            ), patch("installed_macos_permissions.desktop_action", side_effect=desktop_action) as action:
                with self.assertRaisesRegex(RuntimeError, "import preview"):
                    observe_hosted_screen_scan(evidence / "taomni", evidence, recovery)
            action.assert_called_with(steps, "native_show_image_window", {"action": "close"})
            result = json.loads((evidence / "installed-macos-mfa-screen-scan.json").read_text(encoding="utf-8"))
            self.assertFalse(result["passed"])
            self.assertEqual(result["corePid"], 17)
            self.assertEqual(result["imageWindow"], {"pid": 42})

    def test_reports_missing_and_lost_grants_without_counting_them_as_continuity(self):
        trusted = {"screenRecording": "granted", "accessibility": "granted", "requirement": "fixed"}
        self.assertTrue(compare_permissions(trusted, trusted)["retainedBothGrants"])

        denied_screen = {**trusted, "screenRecording": "denied"}
        denied_control = {**trusted, "accessibility": "denied"}
        observed = compare_permissions(denied_screen, denied_control)
        self.assertEqual(observed["missingBaselineGrants"], ["screenRecording"])
        self.assertEqual(observed["lostGrants"], ["accessibility"])
        self.assertFalse(observed["retainedBothGrants"])
        self.assertFalse(compare_permissions(trusted, {**trusted, "requirement": "changed"})["retainedBothGrants"])
