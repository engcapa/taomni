"""Exercise the real shell package helpers without touching the host's apt state."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("ci_linux_apt.sh")


@unittest.skipUnless(shutil.which("bash"), "Linux provisioning uses bash")
class LinuxPackageSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / "commands.jsonl"
        self.apt = self.root / "apt"
        self.apt.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        sudo = self.bin / "sudo"
        sudo.write_text("""#!/usr/bin/env python3
import json, os, subprocess, sys
with open(os.environ['QA_APT_COMMAND_LOG'], 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'tee':
    raise SystemExit(subprocess.run(sys.argv[1:]).returncode)
raise SystemExit(int(os.environ.get('QA_APT_EXIT_CODE', '0')))
""")
        sudo.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
                    "QA_APT_COMMAND_LOG": str(self.log), "GITHUB_ACTIONS": "true"}

    def shell(self, action, *args):
        return subprocess.run(["bash", "-euc", 'source "$1"; "$2" "${@:3}"',
                               "qa-apt-test", str(SCRIPT), action, *args],
                              env=self.env, capture_output=True, text=True)

    def commands(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_package_install_preserves_explicit_packages_and_bounds_network_stalls(self):
        result = self.shell("install_packages", "lxqt-core", "fcitx5-frontend-gtk3")
        self.assertEqual(result.returncode, 0, result.stderr)
        command, = self.commands()
        self.assertEqual(command[-2:], ["lxqt-core", "fcitx5-frontend-gtk3"])
        self.assertIn("--no-install-recommends", command)
        self.assertIn("DEBIAN_FRONTEND=noninteractive", command)
        for option in ("Acquire::Retries=3", "Acquire::http::Timeout=15", "Acquire::https::Timeout=15"):
            self.assertIn(option, command)

    def test_package_failure_is_not_swallowed(self):
        self.env["QA_APT_EXIT_CODE"] = "100"
        self.assertEqual(self.shell("install_packages", "missing-package").returncode, 100)
        self.assertEqual(self.shell("update_package_index").returncode, 100)

    def test_hosted_jammy_uses_official_https_mirrors(self):
        archive = self.apt / "apt-mirrors.txt"
        security = self.apt / "apt-mirrors-security.txt"
        archive.write_text("http://azure.archive.ubuntu.com/ubuntu/\n")
        security.write_text("http://azure.archive.ubuntu.com/ubuntu/\n")
        result = self.shell("prepare_apt_mirrors", "ubuntu-22.04-vnc", str(self.apt))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(archive.read_text(), "https://archive.ubuntu.com/ubuntu/\n")
        self.assertEqual(security.read_text(), "https://security.ubuntu.com/ubuntu/\n")

    def test_other_profiles_and_local_machines_keep_their_mirrors(self):
        archive = self.apt / "apt-mirrors.txt"
        for profile, hosted in (("ubuntu-24.04-xvfb", "true"), ("ubuntu-26.04-wayland", "true"),
                                ("ubuntu-22.04-x11", "false")):
            with self.subTest(profile=profile, hosted=hosted):
                self.env["GITHUB_ACTIONS"] = hosted
                archive.write_text("original mirror\n")
                result = self.shell("prepare_apt_mirrors", profile, str(self.apt))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(archive.read_text(), "original mirror\n")
        self.assertFalse(self.log.exists())

    def test_absent_mirror_lists_are_not_created(self):
        result = self.shell("prepare_apt_mirrors", "ubuntu-22.04-x11", str(self.apt))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.apt.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
