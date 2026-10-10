"""Real distro Gio contracts for cold-cache Wayland application registration."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from ci_desktop import Desktop


@unittest.skipUnless(sys.platform == "linux", "requires Linux distro Gio")
class PortalApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / "data"
        self.applications = self.data / "applications"
        self.applications.mkdir(parents=True)
        self.binary = self.root / "taomni"
        self.entry = self.applications / "com.taomni.app.qa.desktop"
        environment = patch.dict(os.environ, {
            "XDG_DATA_DIRS": str(self.data), "XDG_DATA_HOME": str(self.root / "home-data"),
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.desktop = Desktop(self.root, ["display"], "ubuntu-26.04-wayland")
        self.desktop.facts = {"portal_application": {
            "identifier": "com.taomni.app.qa", "binary": str(self.binary),
            "desktop_file": str(self.entry), "verification": "awaiting-build",
        }}

    def test_cold_cache_requires_completed_executable_then_verifies_real_gio(self):
        with self.assertRaisesRegex(RuntimeError, "executable is unavailable"):
            self.desktop.verify_application()
        self.assertFalse(self.entry.exists())
        self.assertFalse((self.root / "desktop-readiness.json").exists())
        # Disposable executable fixture, independent of an app/native build.
        self.binary.symlink_to("/usr/bin/true")
        self.desktop.verify_application()
        observed = json.loads((self.root / "desktop-readiness.json").read_text())["portal_application"]
        self.assertEqual(observed["verification"], "verified")
        self.assertEqual(observed["observed_id"], self.entry.name)
        self.assertEqual(observed["observed_executable"], str(self.binary))
        self.assertIn("StartupWMClass=taomni\n", self.entry.read_text())

    def test_gio_rejects_prebuild_entry_even_when_desktop_file_exists(self):
        self.entry.write_text(f'[Desktop Entry]\nType=Application\nName=QA\nExec="{self.binary}"\n')
        result = subprocess.run(["/usr/bin/python3", "-c",
            "from gi.repository import Gio; "
            "assert Gio.DesktopAppInfo.new('com.taomni.app.qa.desktop') is not None"],
            capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr, "constructor returned NULL|AssertionError")

    def test_quoted_exec_path_with_spaces_is_verified_without_weakening_identity(self):
        self.binary = self.root / "built binaries" / "taomni"
        self.binary.parent.mkdir()
        self.binary.symlink_to("/usr/bin/true")
        self.desktop.facts["portal_application"]["binary"] = str(self.binary)
        self.desktop.verify_application()
        self.assertEqual(self.desktop.facts["portal_application"]["observed_executable"], str(self.binary))

    def test_real_gio_shadowed_desktop_entry_cannot_be_accepted(self):
        self.binary.symlink_to("/usr/bin/true")
        other = Path(os.environ["XDG_DATA_HOME"]) / "applications"
        other.mkdir(parents=True)
        (other / self.entry.name).write_text(
            '[Desktop Entry]\nType=Application\nName=Other\nExec=/usr/bin/true\nStartupWMClass=taomni\n')
        with self.assertRaises(subprocess.CalledProcessError):
            self.desktop.verify_application()
        self.assertEqual(self.desktop.facts["portal_application"]["verification"], "awaiting-build")
        self.assertFalse((self.root / "desktop-readiness.json").exists())


if __name__ == "__main__":
    unittest.main()
