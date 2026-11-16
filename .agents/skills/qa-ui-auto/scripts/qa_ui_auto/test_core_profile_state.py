"""Read-only evidence must reject absent/corrupt metadata, never fabricate it."""
import json
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from .fixtures import core_profile_state


class CoreProfileStateTest(TestCase):
    def test_reads_the_real_generation_without_rewriting_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            generation = str(uuid.uuid4())
            path = root / ".profile-state.json"
            raw = json.dumps({"formatVersion": 1, "generation": generation}).encode()
            path.write_bytes(raw)
            ctx = SimpleNamespace(values={})
            with patch.object(core_profile_state, "isolated_data_root", return_value=root):
                core_profile_state.setup(ctx)
            self.assertEqual(ctx.values["core_profile_generation"], generation)
            self.assertEqual(ctx.values["core_profile_state_path"], str(path))
            self.assertEqual(path.read_bytes(), raw)

    def test_missing_corrupt_or_noncanonical_metadata_cannot_be_counted_as_evidence(self):
        invalid = [b"broken", b"{}", b"[]", json.dumps({"formatVersion": 1, "generation": str(uuid.UUID(int=0))}).encode(),
                   json.dumps({"formatVersion": 2, "generation": str(uuid.uuid4())}).encode(),
                   json.dumps({"formatVersion": 1, "generation": "A1234567-1234-1234-1234-123456789ABC"}).encode()]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / ".profile-state.json"
            with patch.object(core_profile_state, "isolated_data_root", return_value=root):
                with self.assertRaises(RuntimeError):
                    core_profile_state.setup(SimpleNamespace(values={}))
                self.assertFalse(path.exists())
                for raw in invalid:
                    with self.subTest(raw=raw):
                        path.write_bytes(raw)
                        with self.assertRaises((RuntimeError, ValueError)):
                            core_profile_state.setup(SimpleNamespace(values={}))
                        self.assertEqual(path.read_bytes(), raw)
