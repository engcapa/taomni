import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import project_source


class ProjectSourceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.payload = root / "package"
        self.source_sha = "a" * 40
        self.library = "mpxj-rs-0.1.1"
        cache = root / "registry/cache/local"
        cache.mkdir(parents=True)
        archive = cache / (self.library + ".crate")
        with tarfile.open(archive, "w:gz") as bundle:
            license_text = b"fixture license"
            member = tarfile.TarInfo(self.library + "/LICENSE")
            member.size = len(license_text)
            bundle.addfile(member, io.BytesIO(license_text))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.enterContext(patch.object(project_source, "locked_source", return_value=(self.library, digest)))
        self.enterContext(patch.dict(project_source.os.environ, {"CARGO_HOME": str(root)}))
        project_source.stage(self.payload, self.source_sha)

    def test_license_and_relink_recipe_match_the_locked_library_and_host(self):
        files = project_source.verify(self.payload, self.source_sha)
        self.assertEqual(files, {"licenses/mpxj-rs/" + name for name in
                                 (self.library + ".crate", "LICENSE", "RELINK.md")})
        with self.assertRaisesRegex(ValueError, "RELINK.md"):
            project_source.verify(self.payload, "b" * 40)
        notice = self.payload / project_source.NOTICE
        self.assertEqual((notice / "LICENSE").read_bytes(), b"fixture license")
        self.assertIn(self.source_sha, (notice / "RELINK.md").read_text())

    def test_modified_source_cannot_reach_the_signer(self):
        archive = self.payload / project_source.NOTICE / (self.library + ".crate")
        archive.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Cargo.lock"):
            project_source.verify(self.payload, self.source_sha)
