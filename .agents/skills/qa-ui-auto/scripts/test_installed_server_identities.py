from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest

from installed_server_identities import FILES, seed, verify


class InstalledServerIdentityTests(unittest.TestCase):
    def test_enrollment_and_reinstall_require_the_original_identity(self):
        with TemporaryDirectory() as root:
            profile = Path(root).resolve()
            original = seed(profile)
            self.assertEqual(seed(profile), original)
            for source, target in FILES.items():
                destination = profile / target
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(profile / source, destination)
            self.assertEqual(len(verify(profile, original)), 6)
            destination.write_bytes(b"regenerated")
            with self.assertRaisesRegex(RuntimeError, "differs from its legacy input"):
                verify(profile, original)

    def test_incomplete_identity_is_never_replaced_by_the_fixture(self):
        with TemporaryDirectory() as root:
            profile = Path(root).resolve()
            seed(profile)
            (profile / "rdp-server/key.pem").unlink()
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                seed(profile)
