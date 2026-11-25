"""Unit tests for staging and verifying the Linux SocksCap trace launcher."""

import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from sockscap_linux_resource import LAUNCHER, RESOURCE, files, stage, verify

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src-tauri/plugins/sockscap"


class LinuxSocksCapResourceTests(unittest.TestCase):
    def test_non_linux_and_other_modules_reject_resources_linux(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = Path(directory) / "payload"
            payload.mkdir()
            for slug, platform in (
                ("sockscap", "windows-x86_64"),
                ("sockscap", "darwin-aarch64"),
                ("sockscap", "darwin-x86_64"),
                ("mail", "linux-x86_64"),
            ):
                with self.subTest(slug=slug, platform=platform):
                    self.assertEqual(files(slug, platform), ())
                    stage(slug, platform, SOURCE, payload)
                    self.assertFalse((payload / RESOURCE).exists())
                    verify(slug, platform, payload)
                    (payload / RESOURCE).mkdir(parents=True)
                    with self.assertRaisesRegex(ValueError, "Unexpected Linux"):
                        verify(slug, platform, payload)
                    shutil.rmtree(payload / RESOURCE)

    @unittest.skipUnless(sys.platform.startswith("linux") and shutil.which(os.environ.get("CC", "cc")), "Linux C compiler required")
    def test_stages_and_verifies_real_elf_launcher_and_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / "payload"
            payload.mkdir()
            self.assertEqual(files("sockscap", "linux-x86_64"), ((RESOURCE / LAUNCHER).as_posix(),))
            stage("sockscap", "linux-x86_64", SOURCE, payload)
            verify("sockscap", "linux-x86_64", payload)

            launcher = payload / RESOURCE / LAUNCHER
            original = launcher.read_bytes()
            self.assertTrue(original.startswith(b"\x7fELF"))

            launcher.write_bytes(b"not an elf binary")
            with self.assertRaisesRegex(ValueError, "not an ELF"):
                verify("sockscap", "linux-x86_64", payload)

            launcher.write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "missing or invalid"):
                verify("sockscap", "linux-x86_64", payload)

            launcher.write_bytes(original)
            (payload / RESOURCE / "extra").write_bytes(b"extra")
            with self.assertRaisesRegex(ValueError, "Unexpected or missing"):
                verify("sockscap", "linux-x86_64", payload)
            (payload / RESOURCE / "extra").unlink()

            outside = root / "outside"
            launcher.rename(outside)
            launcher.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "missing or invalid"):
                verify("sockscap", "linux-x86_64", payload)


if __name__ == "__main__":
    unittest.main()
