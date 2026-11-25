from pathlib import Path
import tempfile
import unittest

from installed_macos_memory import PAIRS, app_version


class MacosMemoryTests(unittest.TestCase):
    def test_paired_slots_are_balanced_and_keep_the_installed_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            slot, original, parked = [Path(tmp) / x for x in ("installed", "previous", "parked")]
            slot.write_text("candidate")
            original.write_text("original")
            self.assertEqual(PAIRS.count(("candidate", "original")), PAIRS.count(("original", "candidate")))
            for pair in PAIRS:
                for version in pair:
                    with app_version(version, slot, original, parked):
                        self.assertEqual(slot.read_text(), version)
            self.assertEqual(slot.read_text(), "candidate")
            self.assertEqual(original.read_text(), "original")
            self.assertFalse(parked.exists())

    def test_sampling_failure_restores_candidate_and_monolith(self):
        with tempfile.TemporaryDirectory() as tmp:
            slot, original, parked = [Path(tmp) / x for x in ("installed", "previous", "parked")]
            slot.mkdir()
            original.mkdir()
            (slot / "candidate").touch()
            with self.assertRaisesRegex(RuntimeError, "failed"):
                with app_version("original", slot, original, parked):
                    raise RuntimeError("failed")
            self.assertTrue((slot / "candidate").is_file())
            self.assertTrue(original.is_dir())
            self.assertFalse(parked.exists())
