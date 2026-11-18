"""Unit checks for release input and AppImage process identity."""
from pathlib import Path
import tempfile
import unittest

from installed_linux_formats import appimage_binary, prepare_appimage


class InstalledLinuxFormatTests(unittest.TestCase):
    def test_appimage_launch_copy_preserves_the_artifact_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            original = root / "Taomni.AppImage"
            original.write_bytes(b"AppImage fixture")
            launcher = prepare_appimage(original, root / "launch")
            self.assertEqual(launcher.read_bytes(), original.read_bytes())
            self.assertEqual(launcher.stat().st_mode & 0o777, 0o700)

    def test_appimage_requires_the_exact_launch_path_and_process_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            archive = root / "Taomni.AppImage"
            appdir = root / "unpacked"
            binary = appdir / "usr/bin/taomni"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"executable fixture")
            proc = root / "proc"
            entry = proc / "11"
            entry.mkdir(parents=True)
            (entry / "stat").write_text("11 (taomni) S 10 7 7 0\n")
            (entry / "exe").symlink_to(binary)
            (entry / "environ").write_bytes(f"APPDIR={appdir}\0APPIMAGE={archive}\0".encode())
            self.assertEqual(appimage_binary(archive, 7, proc), binary)
            for candidate, group in [(archive, 17), (root / "other.AppImage", 7)]:
                with self.subTest(candidate=candidate, group=group):
                    with self.assertRaisesRegex(RuntimeError, "matching AppImage"):
                        appimage_binary(candidate, group, proc)


if __name__ == "__main__":
    unittest.main()
