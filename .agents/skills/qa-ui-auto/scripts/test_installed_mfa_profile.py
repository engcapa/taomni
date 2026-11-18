"""Verify the copied profile inventory with inert files."""
from pathlib import Path
import tempfile
import unittest

from installed_mfa_profile import copy_profile
from modular_bundle_inventory import digest


class InstalledMfaProfileTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.root = Path(work.name).resolve()
        self.source = self.root / "original"
        self.destination = self.root / "copy"
        self.files = {
            name: name.encode() for name in (
                ".profile-state.json", ".module-release.json", "taomni.db", "vault.db", "vault.db-wal", "mfa.db",
                "migration/journal.json", "plugins/state.json", "plugins/mfa/active.json",
                "plugins/mfa/versions/0.1.0/taomni-plugin-mfa",
                "plugins/mfa/versions/0.1.0/.taomni-trust/package.taomni-plugin", "plugins/mfa/data/mfa.db",
            )
        }
        for name, content in self.files.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        (self.source / "lanchat.db").write_bytes(b"original chat")
        (self.source / "lanchat.db-wal").write_bytes(b"original chat sidecar")
        (self.source / "vault.db-shm").write_bytes(b"transient")

    def test_copies_original_configs_and_signed_module_without_archived_chat_or_shm(self):
        checksums = copy_profile(self.source, self.destination)
        self.assertEqual(set(checksums), set(self.files))
        for name, content in self.files.items():
            self.assertEqual((self.destination / name).read_bytes(), content)
            self.assertEqual(digest(self.source / name), checksums[name])
        self.assertEqual((self.source / "lanchat.db").read_bytes(), b"original chat")
        self.assertFalse((self.destination / "lanchat.db").exists())
        self.assertFalse((self.destination / "lanchat.db-wal").exists())
        self.assertFalse((self.destination / "vault.db-shm").exists())
        with self.assertRaisesRegex(RuntimeError, "unused profile"):
            copy_profile(self.source, self.destination)

    def test_missing_persistent_inputs_are_rejected_before_copying(self):
        (self.source / "vault.db").unlink()
        with self.assertRaisesRegex(RuntimeError, "vault.db"):
            copy_profile(self.source, self.destination)
        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
