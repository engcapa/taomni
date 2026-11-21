"""Read-only evidence must reject absent/corrupt metadata, never fabricate it."""
import json
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from .fixtures import core_profile_state
from .core_profile_observation import assert_desktop_profile_blocked, assert_headless_profile_blocked, run
from .steps import StepError


class CoreProfileStateTest(TestCase):
    def test_fixture_before_first_start_only_registers_path_and_probe_reads_after_bootstrap(self):
        with tempfile.TemporaryDirectory() as folder:
            # macOS temporary directories may use /var -> /private/var.
            # Match the fixture's canonical run root without weakening the probe.
            root = Path(folder).resolve()
            profile = root / "native-appdata/profile"
            case = root / "TC-MODULES-009"
            case.mkdir()
            profile.mkdir(parents=True)
            generation = str(uuid.uuid4())
            path = profile / ".profile-state.json"
            ctx = SimpleNamespace(values={})
            with patch.object(core_profile_state, "isolated_data_root", return_value=profile):
                core_profile_state.setup(ctx)
            self.assertEqual(ctx.values["core_profile_state_path"], str(path))
            self.assertNotIn("core_profile_generation", ctx.values)
            self.assertFalse(path.exists(), "fixture must not fabricate core bootstrap metadata")
            native = SimpleNamespace(case_dir=case)
            with self.assertRaisesRegex(RuntimeError, "Missing"):
                run(native, {"phase": "capture", "path": str(path)})
            self.assertFalse(path.exists())
            # Model the core creating metadata only when the app is launched.
            raw = json.dumps({"formatVersion": 1, "generation": generation}).encode()
            path.write_bytes(raw)
            run(native, {"phase": "capture", "path": str(path)})
            run(native, {"phase": "unchanged", "path": str(path)})
            self.assertEqual(path.read_bytes(), raw)
            observations = [json.loads(line) for line in (case / "core-profile-observations.jsonl").read_text().splitlines()]
            self.assertEqual([item["passed"] for item in observations], [False, True, True])
            self.assertEqual(observations[-1]["generation"], generation)

    def test_changed_generation_cannot_be_hidden_by_recapturing_or_a_different_path(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            case, profile = root / "case", root / "profile"
            case.mkdir()
            profile.mkdir()
            path = profile / ".profile-state.json"
            raw = json.dumps({"formatVersion": 1, "generation": str(uuid.uuid4())}).encode()
            path.write_bytes(raw)
            ctx = SimpleNamespace(case_dir=case)
            args = {"phase": "unchanged", "path": str(path)}
            with self.assertRaisesRegex(StepError, "no pre-restart baseline"):
                run(ctx, args)
            run(ctx, {**args, "phase": "capture"})
            changed = json.dumps({"formatVersion": 1, "generation": str(uuid.uuid4())}).encode()
            path.write_bytes(changed)
            with self.assertRaisesRegex(StepError, "generation changed"):
                run(ctx, args)
            with self.assertRaisesRegex(StepError, "recapture"):
                run(ctx, {**args, "phase": "capture"})
            with self.assertRaisesRegex(StepError, "escaped"):
                run(ctx, {**args, "path": str(case / ".profile-state.json")})
            self.assertEqual(path.read_bytes(), changed)

    def test_missing_corrupt_or_noncanonical_metadata_cannot_be_counted_as_evidence(self):
        invalid = [b"broken", b"{}", b"[]", json.dumps({"formatVersion": 1, "generation": str(uuid.UUID(int=0))}).encode(),
                   json.dumps({"formatVersion": 2, "generation": str(uuid.uuid4())}).encode(),
                   json.dumps({"formatVersion": 1, "generation": "A1234567-1234-1234-1234-123456789ABC"}).encode()]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            path = root / ".profile-state.json"
            with self.assertRaises(RuntimeError):
                core_profile_state.read_generation(path)
            self.assertFalse(path.exists())
            for raw in invalid:
                with self.subTest(raw=raw):
                    path.write_bytes(raw)
                    with self.assertRaises((RuntimeError, ValueError)):
                        core_profile_state.read_generation(path)
                    self.assertEqual(path.read_bytes(), raw)

    def test_launch_probe_uses_only_the_active_application_and_its_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            case, profile = root / "case", root / "profile"
            case.mkdir()
            profile.mkdir()
            generation = str(uuid.uuid4())
            (profile / ".profile-state.json").write_text(json.dumps({
                "formatVersion": 1, "generation": generation,
            }), encoding="utf-8")
            application = root / "taomni"
            application.touch()
            session = Mock(application=application)
            owner = SimpleNamespace(case_id="TC-MODULES-009")
            ctx = SimpleNamespace(session=session, fixture_context=owner, case_dir=case)
            outcome = {"exitCode": 1, "modeLeaseError": True, "openedEndpoint": False, "ownerStillRunning": True}
            marker = profile / "migration/mfa-transaction.json"

            def run_contender(argv, desktop_alive, evidence, label, *, desktop_env=None):
                self.assertEqual(argv, [str(application), "--headless", "--data-dir", str(profile), "--mobile-port", "0"])
                self.assertTrue(desktop_alive())
                self.assertEqual(marker.exists(), label.endswith("pending-mfa"))
                return outcome

            with patch("qa_ui_auto.core_profile_observation.isolated_data_root", return_value=profile) as isolated, \
                 patch("qa_ui_auto.core_profile_observation.observe_foreign_executable",
                       return_value={"exitCode": 1, "rejected": True}) as guard:
                with patch("qa_ui_auto.core_profile_observation.observe_same_profile_contender", side_effect=run_contender):
                    assert_headless_profile_blocked(ctx, None)
                    isolated.assert_called_once_with(owner)
                    guard.assert_called_once_with(application, profile, case)
                    self.assertEqual(session.wait_for_app_ready.call_count, 3)
                    receipt = case / "desktop-mode-lease.json"
                    result = json.loads(receipt.read_text())
                    self.assertEqual(result["generation"], generation)
                    self.assertTrue(result["pendingMfaRecoveryContender"]["recoveryRecordPreserved"])
                    self.assertTrue(result["mfaRelaunchExecutableGuard"]["ownerStillRunning"])
                    self.assertFalse(marker.exists())
                    outcome["openedEndpoint"] = True
                    with self.assertRaisesRegex(StepError, "before opening an endpoint"):
                        assert_headless_profile_blocked(ctx, None)
                    self.assertFalse(json.loads(receipt.read_text())["passed"])

    def test_running_headless_owner_requires_the_real_desktop_lease_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            application = root / "taomni"
            application.touch()
            profile = root / "com.taomni.app.qa"
            profile.mkdir()
            generation = str(uuid.uuid4())
            (profile / ".profile-state.json").write_text(json.dumps({
                "formatVersion": 1, "generation": generation,
            }), encoding="utf-8")
            ctx = SimpleNamespace(session=SimpleNamespace(application=application),
                                  fixture_context=Mock(), case_dir=root)
            owner = Mock()
            owner.poll.return_value = None
            result = {"exitCode": 1, "modeLeaseError": True, "openedEndpoint": False, "ownerStillRunning": True}
            marker = profile / "migration/mfa-transaction.json"
            fail_pending_recovery = False

            def start_headless(binary, data, work, evidence, label, *, observe_ready):
                self.assertEqual((binary, data, evidence), (application, profile, root))
                self.assertNotEqual(work, evidence)
                observe_ready(owner)
                return {"ready": True, "exited": True}

            def try_contender(argv, alive, evidence, label, *, desktop_env):
                self.assertEqual(argv, [str(application)])
                self.assertEqual(desktop_env["NEWMOB_DATA_DIR"], str(profile))
                self.assertTrue(alive())
                if label.endswith("pending-mfa"):
                    self.assertEqual(marker.read_bytes(), b"{}\n")
                    if fail_pending_recovery:
                        return {**result, "exitCode": -6}
                else:
                    self.assertFalse(marker.exists())
                return result

            prefix = "qa_ui_auto.core_profile_observation."
            with patch(prefix + "isolated_data_root", return_value=profile), \
                    patch(prefix + "initialize_profile", side_effect=start_headless), \
                    patch(prefix + "observe_same_profile_contender", side_effect=try_contender):
                assert_desktop_profile_blocked(ctx)
                receipt = root / "headless-mode-lease.json"
                passed = json.loads(receipt.read_text())
                self.assertTrue(passed["passed"])
                self.assertTrue(passed["pendingMfaRecoveryContender"]["recoveryRecordPreserved"])
                self.assertFalse(marker.exists())
                fail_pending_recovery = True
                with self.assertRaisesRegex(StepError, "preserve the MFA recovery record"):
                    assert_desktop_profile_blocked(ctx)
                failed = json.loads(receipt.read_text())
                self.assertFalse(failed["passed"])
                self.assertEqual(failed["desktopContender"]["exitCode"], 1)
                self.assertEqual(failed["pendingMfaRecoveryContender"]["exitCode"], -6)
                self.assertFalse(marker.exists())
