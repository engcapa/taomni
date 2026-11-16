"""Read-only evidence must reject absent/corrupt metadata, never fabricate it."""
import json
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from .fixtures import core_profile_state
from .core_profile_observation import run
from .steps import StepError


class CoreProfileStateTest(TestCase):
    def test_fixture_before_first_start_only_registers_path_and_probe_reads_after_bootstrap(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
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
            root = Path(folder)
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
            root = Path(folder)
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
