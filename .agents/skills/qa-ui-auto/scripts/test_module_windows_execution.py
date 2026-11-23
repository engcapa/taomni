"""Pure evidence/selection contracts; no Windows APIs, network or app processes."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("module_windows_gate", ROOT / "scripts/run-module-windows-execution-gates.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class WindowsExecutionGateTests(unittest.TestCase):
    def test_only_disposable_github_windows_can_run_the_experiment(self):
        for system, actions, runner in [("Linux", "true", "github-hosted"),
                                        ("Windows", "false", "github-hosted"),
                                        ("Windows", "true", "self-hosted")]:
            with patch.object(gate.platform, "system", return_value=system), \
                    patch.dict(os.environ, {"GITHUB_ACTIONS": actions, "RUNNER_ENVIRONMENT": runner}):
                with self.assertRaisesRegex(RuntimeError, "disposable GitHub"):
                    gate.require_hosted()
        with patch.object(gate.platform, "system", return_value="Windows"), \
                patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted"}):
            gate.require_hosted()

    def test_observation_keeps_paths_out_of_the_powershell_program(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "quoted ' module ; name.exe"
            with patch.object(gate, "run_command", return_value=(0, '{"defender":{"available":false}}')) as run:
                self.assertFalse(gate.observe(Path(temporary), "security", "security", target)["defender"]["available"])
            command = run.call_args.args[0]
            self.assertNotIn("-Command", command)
            self.assertNotIn(str(target), command)
            self.assertEqual(run.call_args.kwargs["environment"]["TAOMNI_OBSERVED_MODULE_HOST"], str(target))

    def test_a_signed_or_mismarked_or_different_executable_is_not_unsigned_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary).resolve() / "inert.exe"
            other = target.with_name("other.exe")
            for path in [target, other]:
                path.write_bytes(b"inert bytes, never executed")
            valid = {"path": str(target), "authenticodeStatus": "NotSigned", "zoneIdentifier": gate.ZONE}
            gate.validate_host_observation(valid, target, downloaded=True)
            for change in [{"path": str(other)}, {"authenticodeStatus": "UnknownError"},
                           {"authenticodeStatus": "Valid"}, {"zoneIdentifier": None},
                           {"zoneIdentifier": gate.ZONE.replace("ZoneId=3", "ZoneId=2")}]:
                with self.assertRaises(RuntimeError):
                    gate.validate_host_observation({**valid, **change}, target, downloaded=True)

    def test_harness_selection_rejects_the_macos_or_non_test_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary).resolve() / "inert.exe"
            target.write_bytes(b"inert")
            row = {"reason": "compiler-artifact", "profile": {"test": True},
                   "target": {"name": "windows_system_execution"}, "executable": str(target)}
            self.assertEqual(gate.select_harness(json.dumps(row), "windows_system_execution"), target)
            row["target"]["name"] = "system_execution"
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                gate.select_harness(json.dumps(row), "windows_system_execution")

    def run_mock_experiment(self, root, *, process_code=0, listing_count=2, mutate_zone=False,
                            require_defender=False, defender_states=None):
        artifacts = root / "source"
        artifacts.mkdir()
        harness = artifacts / "harness.exe"
        harness.write_bytes(b"inert-harness")
        manifest = root / "src-tauri/plugins/mfa/module.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text('{"version":"0.1.2"}', encoding="utf-8")
        for name in ["taomni-hello-plugin.exe", "taomni-plugin-mfa.exe"]:
            path = root / "src-tauri/target/debug" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"inert-host")
        def command(argv, evidence, name, **kwargs):
            if name == "source":
                return 0, "b" * 40
            if name == "harness-build":
                return 0, json.dumps({"reason": "compiler-artifact", "profile": {"test": True},
                                      "target": {"name": "windows_system_execution"}, "executable": str(harness)})
            if name == "selection":
                return 0, "\n".join(f"experiment_{i}: test" for i in range(listing_count))
            if name == "system-process":
                return process_code, "test result: ok. 2 passed; 0 failed; 0 ignored" if process_code == 0 else "denied"
            raise AssertionError(f"Unexpected command: {argv}")
        def observe(evidence, name, operation, target=None):
            if operation == "security":
                if defender_states is not None:
                    return {"defender": {"available": True, "realTimeProtectionEnabled": next(defender_states)}}
                return {"defender": {"available": False, "error": "mock unavailable"}}
            zone = None if target.name == "gate-core.exe" else gate.ZONE
            if mutate_zone and name == "hello-after":
                zone = None
            return {"path": str(target), "authenticodeStatus": "NotSigned", "zoneIdentifier": zone}
        with patch.object(gate, "ROOT", root), patch.object(gate, "require_hosted"), \
                patch.dict(os.environ, {"LOCALAPPDATA": str(root)}), \
                patch.object(gate, "run_command", side_effect=command), patch.object(gate, "observe", side_effect=observe):
            gate.run(root / "evidence", require_defender=require_defender)

    def test_success_preserves_unverified_trust_and_unavailable_security_observation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.run_mock_experiment(root)
            receipt = json.loads((root / "evidence/windows-execution-receipt.json").read_text())
            self.assertTrue(receipt["allSelectedPassed"])
            self.assertEqual(receipt["sourceSha"], "b" * 40)
            self.assertEqual(len(receipt["artifacts"]), 3)
            self.assertFalse(receipt["securityBefore"]["defender"]["available"])
            for boundary in ["releasePackage", "systemTrust", "smartScreenReputation"]:
                self.assertEqual(receipt[boundary], "unverified")
            self.assertFalse(list(root.glob("taomni-module-execution-*")))

    def test_failure_empty_selection_and_changed_zone_never_claim_success(self):
        for options in [{"process_code": 1}, {"listing_count": 0}, {"mutate_zone": True}]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                with self.assertRaises(RuntimeError):
                    self.run_mock_experiment(root, **options)
                receipt = json.loads((root / "evidence/windows-execution-receipt.json").read_text())
                self.assertFalse(receipt["allSelectedPassed"])
                self.assertFalse(list(root.glob("taomni-module-execution-*")))

    def test_required_defender_must_remain_active_before_and_after_launch(self):
        for states in ((False, True), (True, False), (True, True)):
            with self.subTest(states=states), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                options = {"require_defender": True, "defender_states": iter(states)}
                if all(states):
                    self.run_mock_experiment(root, **options)
                else:
                    with self.assertRaisesRegex(RuntimeError, "Defender real-time protection"):
                        self.run_mock_experiment(root, **options)
                receipt = json.loads((root / "evidence/windows-execution-receipt.json").read_text())
                self.assertIs(receipt["allSelectedPassed"], all(states))


if __name__ == "__main__":
    unittest.main()
