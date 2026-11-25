import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from sockscap_xray_resource import RESOURCE, digest, stage, verify


class XrayResourceTests(unittest.TestCase):
    def test_staging_binds_archive_target_and_both_signed_files(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / "module"
            (source / RESOURCE).mkdir(parents=True)
            archive = root / "Xray-windows-64.zip"
            binary = b"Windows executable"
            license_text = b"Upstream license"
            with zipfile.ZipFile(archive, "w") as packed:
                packed.writestr("xray.exe", binary)
                packed.writestr("LICENSE", license_text)
                packed.writestr("geosite.dat", b"unused")
            platform = "windows-x86_64"
            release = {
                "version": "v1",
                "licenseSha256": hashlib.sha256(license_text).hexdigest(),
                "platforms": {platform: {
                    "archive": archive.name,
                    "archiveSha256": digest(archive),
                    "binarySha256": hashlib.sha256(binary).hexdigest(),
                }},
            }
            (source / RESOURCE / "release.json").write_text(json.dumps(release), encoding="utf-8")
            payload = root / "payload"
            stage(source, platform, payload, archive)
            verify(source, platform, payload)
            self.assertEqual({p.name for p in (payload / RESOURCE).iterdir()}, {"xray.exe", "LICENSE"})
            (payload / RESOURCE / "xray.exe").write_bytes(b"other executable")
            with self.assertRaisesRegex(ValueError, "pinned upstream release"):
                verify(source, platform, payload)
            archive.write_bytes(b"changed upstream archive")
            with self.assertRaisesRegex(ValueError, "Unexpected SHA-256"):
                stage(source, platform, root / "untouched", archive)
            self.assertFalse((root / "untouched").exists())
