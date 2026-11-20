"""Regression tests for the GitHub workflow dispatch lookup."""

import subprocess
import unittest
from unittest.mock import call, patch

from modular_gate_runs import PLATFORMS, UPGRADE, api, plan


class GitHubRunLookupTests(unittest.TestCase):
    def test_new_run_can_be_missing_after_dispatch(self):
        command = ["gh", "api", "repos/engcapa/taomni/actions/runs/123"]
        missing = subprocess.CompletedProcess(command, 1, "", "gh: Not Found (HTTP 404)\n")
        available = subprocess.CompletedProcess(command, 0, '{"head_sha": "source-sha"}', "")
        with patch("modular_gate_runs.subprocess.run", side_effect=[missing, missing, available]) as run:
            with patch("modular_gate_runs.time.sleep") as sleep:
                self.assertEqual(api("engcapa/taomni", "actions/runs/123", retry_missing=True),
                                 {"head_sha": "source-sha"})
        self.assertEqual([args.args[0] for args in run.call_args_list], [command] * 3)
        self.assertEqual(sleep.call_args_list, [call(1), call(2)])

    def test_missing_run_fails_after_the_lookup_budget(self):
        missing = subprocess.CompletedProcess([], 1, "", "gh: Not Found (HTTP 404)\n")
        with patch("modular_gate_runs.subprocess.run", return_value=missing) as run:
            with patch("modular_gate_runs.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, r"actions/runs/123.*HTTP 404"):
                    api("engcapa/taomni", "actions/runs/123", retry_missing=True)
        self.assertEqual(run.call_count, 6)

    def test_only_a_missing_child_read_can_retry(self):
        for body, failure in ((None, "HTTP 403"), ({"ref": "main"}, "HTTP 404")):
            with self.subTest(body=body, failure=failure):
                result = subprocess.CompletedProcess([], 1, "", f"gh: Request failed ({failure})\n")
                with patch("modular_gate_runs.subprocess.run", return_value=result) as run:
                    with self.assertRaisesRegex(RuntimeError, failure):
                        api("engcapa/taomni", "some-endpoint", body=body, retry_missing=True)
                run.assert_called_once()


class SignedModuleSelectionTests(unittest.TestCase):
    def test_signed_gate_runs_independently_of_release_installers(self):
        signed = plan("signed", "macos-15", "", "")
        self.assertEqual(len(signed), 1)
        self.assertEqual(signed[0][1:], (UPGRADE, {"signed_mfa_only": "true"}))
        self.assertIn(signed[0], plan("all", "macos-15", "", ""))


class DesktopGateSelectionTests(unittest.TestCase):
    def test_desktop_gate_covers_affected_capture_headless_rdp_and_mail_cases(self):
        desktop, wayland = plan("desktop", "macos-26", "", "")
        self.assertEqual(desktop[1], PLATFORMS)
        inputs = desktop[2]
        self.assertEqual(inputs["platforms"], "linux,windows,macos")
        self.assertEqual(inputs["modes"], "browser,native")
        self.assertEqual(inputs["linux_profiles"], "ubuntu-24.04-xvfb")
        self.assertEqual(inputs["macos_runner"], "macos-26")
        self.assertEqual(inputs["native_release"], "true")
        self.assertEqual(inputs["modular_rdp_p95"], "true")
        self.assertEqual(set(inputs["case_ids"].split(",")), {
            "TC-MFA-106", "TC-MOBILE-003", "TC-MOBILE-021",
            "TC-SHOT-003", "TC-SHOT-N2", "TC-SHOT-N10", "TC-SHOT-N15", "TC-SHOT-N19",
            "TC-RDPS-NAT-01-start-connect-display", "TC-RDPS-PERF-01-performance-budget",
            "TC-MAIL-SEND-01", "TC-MAIL-OUTBOX-01", "TC-MAIL-ATTACH-01", "TC-MAIL-FOLDER-01",
            *(f"TC-MAIL-STORAGE-{number:02d}" for number in range(1, 10)),
        })
        self.assertEqual(wayland[1], PLATFORMS)
        wayland_inputs = wayland[2]
        self.assertEqual(wayland_inputs["platforms"], "linux")
        self.assertEqual(wayland_inputs["modes"], "native")
        self.assertEqual(wayland_inputs["linux_profiles"], "ubuntu-26.04-wayland")
        self.assertEqual(wayland_inputs["native_release"], "true")
        self.assertEqual(wayland_inputs["modular_rdp_p95"], "true")
        self.assertEqual(set(wayland_inputs["case_ids"].split(",")), {
            "TC-MFA-106", "TC-SHOT-N2", "TC-SHOT-N10",
            "TC-RDPS-NAT-01-start-connect-display", "TC-RDPS-PERF-01-performance-budget",
        })
        checks = plan("all", "macos-26", "", "")
        self.assertIn(desktop, checks)
        self.assertIn(wayland, checks)


class ReleasePackageSelectionTests(unittest.TestCase):
    def test_partial_desktop_selection_runs_inspection_and_upgrade_in_one_job(self):
        checks = plan("release", "macos-26", "123", "0.5.11", "darwin-aarch64")
        self.assertEqual(len(checks), 1)
        self.assertEqual(checks[0][2], {
            "package_run": "123", "package_version": "0.5.11", "package_targets": "darwin-aarch64",
            "package_upgrade_desktop": "true", "package_macos_arm_runner": "macos-26",
        })

    def test_all_keeps_linux_inspection_and_installed_checks_and_every_desktop_target(self):
        linux_inventory, linux_recovery, desktop = [check[2] for check in plan("release", "macos-15", "123", "0.5.11")]
        self.assertEqual(linux_inventory["package_targets"], "linux-x86_64")
        self.assertEqual(linux_recovery["package_targets"], "linux-x86_64")
        self.assertEqual(linux_recovery["package_relocation_linux"], "true")
        self.assertEqual(linux_recovery["package_rdp_perf"], "true")
        self.assertEqual(desktop["package_targets"], "windows-x86_64,darwin-aarch64,darwin-x86_64")

    def test_unknown_or_repeated_targets_fail_before_dispatch(self):
        for targets in ("all,linux-x86_64", "windows-x86_64,windows-x86_64", "darwin-aarch64,"):
            with self.subTest(targets=targets), self.assertRaisesRegex(ValueError, "supported release package targets"):
                plan("release", "macos-15", "123", "0.5.11", targets)
