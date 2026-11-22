import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from sockscap_redirector_resource import ARCHIVE, RESOURCE, files, stage, verify


class RedirectorPackaging(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.source = Path(temp.name) / "source"
        self.payload = Path(temp.name) / "payload"
        directory = self.source / RESOURCE
        directory.mkdir(parents=True)
        archive = b"upstream-signed installer fixture"
        (directory / ARCHIVE).write_bytes(archive)
        (directory / "manifest.json").write_text(json.dumps({
            "appTarSha256": hashlib.sha256(archive).hexdigest(),
        }))
        (directory / "LICENSE").write_text("upstream license")

    def test_both_mac_packages_carry_the_pinned_archive_and_license(self):
        for platform in ("darwin-aarch64", "darwin-x86_64"):
            with self.subTest(platform=platform):
                self.assertEqual(len(files("sockscap", platform)), 3)
                stage("sockscap", platform, self.source, self.payload)
                verify("sockscap", platform, self.source, self.payload)
                for name in (ARCHIVE, "LICENSE", "manifest.json"):
                    with self.subTest(file=name):
                        member = self.payload / RESOURCE / name
                        original = member.read_bytes()
                        member.write_bytes(original + b"changed")
                        with self.assertRaises(ValueError):
                            verify("sockscap", platform, self.source, self.payload)
                        member.write_bytes(original)

    def test_other_modules_and_platforms_exclude_the_installer(self):
        for slug, platform in (("mail", "darwin-aarch64"), ("sockscap", "linux-x86_64"),
                               ("sockscap", "windows-x86_64")):
            with self.subTest(slug=slug, platform=platform):
                stage(slug, platform, self.source, self.payload)
                self.assertFalse(self.payload.exists())
                verify(slug, platform, self.source, self.payload)
                with self.assertRaises(ValueError):
                    verify(slug, platform, self.source, self.source)


if __name__ == "__main__":
    unittest.main()
