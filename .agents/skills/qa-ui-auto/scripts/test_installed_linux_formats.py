"""Unit checks for release input and AppImage process identity."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from installed_linux_formats import appimage_binary, install_rpm, prepare_appimage
from installed_mfa_upgrade import close_verified_desktop


class InstalledLinuxFormatTests(unittest.TestCase):
    def test_appimage_shutdown_uses_the_verified_child_that_owns_the_window(self):
        driver = SimpleNamespace(proc=SimpleNamespace(pid=17))
        launcher = Path("Taomni.AppImage")
        binary = Path("unpacked/usr/bin/taomni")
        session = SimpleNamespace(application=launcher)

        def close(owned_driver, owned_session, executable):
            self.assertIs(owned_driver, driver)
            self.assertEqual(executable, binary)
            self.assertEqual(owned_session.application, binary)
            return {"close": "confirmed"}

        with patch("installed_mfa_upgrade.appimage_binary", return_value=binary) as identify, \
                patch("installed_mfa_upgrade.digest", return_value="verified-digest"), \
                patch("installed_mfa_upgrade.close_installed_desktop", side_effect=close):
            result = close_verified_desktop(driver, session, launcher)
        identify.assert_called_once_with(launcher, driver.proc.pid)
        self.assertEqual(result, {"launchedBinarySha256": "verified-digest", "close": "confirmed"})
        self.assertEqual(session.application, launcher)

    def test_rpm_registration_queries_use_the_installers_package_database(self):
        result = SimpleNamespace(stdout=b"taomni 0.5.11 x86_64")
        with patch("installed_linux_formats.command", return_value=result) as command, patch.object(Path, "is_file", return_value=True):
            binary = install_rpm(Path("Taomni.rpm"), "0.5.11", Path("evidence"))
        self.assertEqual(binary, Path("/usr/bin/taomni"))
        commands = {call.args[2]: call.args[0] for call in command.call_args_list}
        for name in ("rpm-install", "rpm-installed", "rpm-executable-owner"):
            self.assertEqual(commands[name][:2], ["sudo", "rpm"])

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
