import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from ci_cargo_artifact import ARCHIVE_NAME, PROFILE_DIRS, SHERPA, pack, restore
from qa_ui_auto.provenance import digest_file


class CargoArtifactTests(unittest.TestCase):
    def test_modern_cargo_preserves_build_units_and_omits_workspace_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "src-target"
            for package in ("taomni", "serde"):
                unit = target / "release" / "build" / package / "0123456789abcdef"
                unit.joinpath("out").mkdir(parents=True)
                unit.joinpath("fingerprint").mkdir()
                unit.joinpath("out", "artifact").write_text(package)
                unit.joinpath("fingerprint", "lib").write_text("fingerprint")
            artifact, restored = root / "artifact", root / "restored"
            pack(artifact, "release", target=target, cargo_home=root / "cargo", units={"taomni"})

            self.assertFalse(restore(artifact, "release", target=restored, cargo_home=root / "cargo"))
            build = restored / "release" / "build"
            self.assertEqual([path.name for path in build.iterdir()], ["serde"])
            unit = build / "serde" / "0123456789abcdef"
            self.assertEqual(unit.joinpath("out", "artifact").read_text(), "serde")
            self.assertEqual(unit.joinpath("fingerprint", "lib").read_text(), "fingerprint")

    def test_preserves_third_party_dependencies_and_sherpa_without_local_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "src-target"
            for directory in PROFILE_DIRS:
                path = target / "release" / directory
                path.mkdir(parents=True)
                path.joinpath("libtaomni_lib-0123456789abcdef.d").touch()
                path.joinpath("serde-0123456789abcdef.d").write_text("dependency")
            (target / SHERPA).mkdir()
            target.joinpath(SHERPA, "sherpa-onnx.dll").write_bytes(b"sherpa")
            artifact, restored = root / "artifact", root / "restored"

            pack(artifact, "release", target=target, cargo_home=root / "cargo",
                 units={"taomni_lib", "libtaomni_lib"})
            self.assertTrue(restore(artifact, "release", target=restored, cargo_home=root / "cargo"))
            for directory in PROFILE_DIRS:
                paths = list((restored / "release" / directory).iterdir())
                self.assertEqual([p.name for p in paths], ["serde-0123456789abcdef.d"])
                self.assertEqual(paths[0].read_text(), "dependency")
            self.assertEqual(restored.joinpath(SHERPA, "sherpa-onnx.dll").read_bytes(), b"sherpa")

    def test_rejects_a_corrupt_or_foreign_archive_before_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / ARCHIVE_NAME
            with tarfile.open(archive, "w:gz") as stream:
                entry = tarfile.TarInfo("target/release/deps/../../foreign")
                entry.size = 1
                stream.addfile(entry, io.BytesIO(b"a"))
            output = root / "target"
            root.joinpath("sha256").write_text("bad")
            with self.assertRaisesRegex(ValueError, "checksum differs"):
                restore(root, "release", target=output, cargo_home=root / "cargo")
            root.joinpath("sha256").write_text(digest_file(archive))
            with self.assertRaisesRegex(ValueError, "unexpected Cargo"):
                restore(root, "release", target=output, cargo_home=root / "cargo")
            self.assertFalse(list(output.iterdir()))


if __name__ == "__main__":
    unittest.main()
