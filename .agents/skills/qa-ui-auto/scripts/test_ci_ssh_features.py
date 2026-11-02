"""Authenticated Cygwin installation, owned SSH homes and SCP receipt paths."""
import os
from pathlib import Path, PureWindowsPath
import hashlib
import tempfile
import unittest
from unittest.mock import Mock, patch

import ci_ssh_features
from ci_ssh_features import prepare_cygwin_home, transfer_paths


class CygwinInstallerTest(unittest.TestCase):
    def test_versioned_installer_is_verified_before_execution_and_publication(self):
        from ci_ssh_features import CYGWIN_SETUP_URL, install

        payload = b"verified test installer"
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "github-env"
            with patch.dict(os.environ, {"RUNNER_TEMP": directory, "GITHUB_ENV": str(env_file)}), \
                    patch("ci_ssh_features.platform.system", return_value="Windows"), \
                    patch("ci_ssh_features.CYGWIN_SETUP_SHA256", hashlib.sha256(payload).hexdigest()), \
                    patch("ci_ssh_features.urllib.request.urlretrieve",
                          side_effect=lambda url, path: path.write_bytes(payload)) as download, \
                    patch("ci_ssh_features.subprocess.run") as execute:
                execute.return_value.returncode = 0
                install()
                self.assertRegex(CYGWIN_SETUP_URL, r"/setup/setup-\d+\.\d+\.x86_64\.exe$")
                download.assert_called_once()
                url, destination = download.call_args.args
                self.assertEqual(url, CYGWIN_SETUP_URL)
                self.assertEqual(destination.name, "setup.exe")
                self.assertEqual(destination.parent.parent, Path(directory))
                self.assertFalse(destination.parent.exists())
                self.assertEqual(execute.call_count, 1)
                self.assertIn("QA_CYGWIN_ROOT=", env_file.read_text())

    def test_checksum_mismatch_cannot_execute_or_publish_the_installation(self):
        from ci_ssh_features import install

        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "github-env"
            with patch.dict(os.environ, {"RUNNER_TEMP": directory, "GITHUB_ENV": str(env_file)}), \
                    patch("ci_ssh_features.platform.system", return_value="Windows"), \
                    patch("ci_ssh_features.urllib.request.urlretrieve",
                          side_effect=lambda url, path: path.write_bytes(b"unexpected installer")), \
                    patch("ci_ssh_features.subprocess.run") as execute:
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    install()
                execute.assert_not_called()
                self.assertFalse(env_file.exists())


class TransferPathsTest(unittest.TestCase):
    def test_cygwin_protocol_path_is_not_a_windows_disk_path(self):
        remote = PureWindowsPath("D:/qa-cygwin/home/runneradmin/taomni-qa-ssh-features")
        local = PureWindowsPath("C:/Users/runneradmin/AppData/Local/Temp/qa/local")
        paths = transfer_paths(remote, "/home/runneradmin/taomni-qa-ssh-features", local)

        self.assertEqual(paths["remote_dir"], "/home/runneradmin/taomni-qa-ssh-features")
        self.assertEqual(paths["source"], "/home/runneradmin/taomni-qa-ssh-features/scp-source.txt")
        self.assertEqual(paths["uploaded"], "D:/qa-cygwin/home/runneradmin/taomni-qa-ssh-features/scp-upload.txt")
        self.assertEqual(paths["downloaded"], "C:/Users/runneradmin/AppData/Local/Temp/qa/local/scp-source.txt")
        self.assertTrue(PureWindowsPath(paths["uploaded"]).is_absolute())
        self.assertFalse(PureWindowsPath(paths["remote_dir"]).is_absolute())

    def test_host_receipts_read_the_actual_files_with_distinct_ssh_namespace(self):
        with tempfile.TemporaryDirectory() as directory:
            remote = Path(directory) / "server"
            local = Path(directory) / "client"
            remote.mkdir()
            local.mkdir()
            (remote / "scp-upload.txt").write_bytes(b"qa-scp-upload\n")
            (local / "scp-source.txt").write_bytes(b"qa-scp-roundtrip\n")
            paths = transfer_paths(remote, "/home/tester/fixture", local)
            self.assertEqual(Path(paths["uploaded"]).read_bytes(), b"qa-scp-upload\n")
            self.assertEqual(Path(paths["downloaded"]).read_bytes(), b"qa-scp-roundtrip\n")
            self.assertEqual(paths["source"], "/home/tester/fixture/scp-source.txt")


class CygwinInstallTest(unittest.TestCase):
    # Pin test bytes independently too: a corrupt download must never become
    # its own expected checksum. No real installer is executed by these tests.
    payload = b"verified setup fixture\n"
    sha256 = "586d015c391e66410629c37176ca73e775f722644931006f104ae9aafc6e83e2"

    def test_official_versioned_archive_keeps_the_authenticated_pin(self):
        self.assertEqual(ci_ssh_features.CYGWIN_SETUP_URL,
                         "https://cygwin.com/setup/setup-2.941.x86_64.exe")
        self.assertEqual(ci_ssh_features.CYGWIN_SETUP_SHA256,
                         "9d31ffc08b14eaaf5ddf15799a934f6bc1be3d87ed986736cb1980c508ed9502")

    def test_only_verified_installer_runs_in_a_fresh_directory_per_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            github_env = root / "github-env"
            downloads = []

            def download(url, destination):
                self.assertEqual(url, "https://cygwin.com/setup/setup-2.941.x86_64.exe")
                path = Path(destination)
                self.assertEqual(path.parent.parent, root)
                self.assertEqual(list(path.parent.iterdir()), [])
                downloads.append(path)
                path.write_bytes(self.payload)

            def execute(args, *, timeout):
                self.assertEqual(Path(args[0]), downloads[-1])
                self.assertEqual(Path(args[0]).read_bytes(), self.payload)
                self.assertEqual(args[1:], [
                    "--quiet-mode", "--no-shortcuts", "--no-startmenu", "--no-desktop",
                    "--root", str(root / "qa-cygwin"),
                    "--local-package-dir", str(root / "qa-cygwin-packages"),
                    "--site", "https://mirrors.kernel.org/sourceware/cygwin/", "--packages",
                    "openssh,krb5-server,krb5-workstation,python3,coreutils",
                ])
                self.assertEqual(timeout, 900)
                self.assertFalse(github_env.exists())
                return Mock(returncode=0)

            with patch.object(ci_ssh_features.platform, "system", return_value="Windows"), \
                 patch.dict(os.environ, {"RUNNER_TEMP": directory, "GITHUB_ENV": str(github_env)}), \
                 patch.object(ci_ssh_features, "CYGWIN_SETUP_SHA256", self.sha256), \
                 patch.object(ci_ssh_features.urllib.request, "urlretrieve", side_effect=download) as retrieve, \
                 patch.object(ci_ssh_features.subprocess, "run", side_effect=execute) as run:
                for _ in range(2):
                    github_env.unlink(missing_ok=True)
                    ci_ssh_features.install()
                    self.assertEqual(os.environ["QA_CYGWIN_ROOT"], (root / "qa-cygwin").as_posix())
                    self.assertEqual(github_env.read_text(encoding="utf-8"),
                                     f"QA_CYGWIN_ROOT={(root / 'qa-cygwin').as_posix()}\n")
                self.assertEqual(retrieve.call_count, 2)
                self.assertEqual(run.call_count, 2)
            self.assertNotEqual(downloads[0].parent, downloads[1].parent)
            self.assertTrue(all(not path.parent.exists() for path in downloads))

    def test_checksum_mismatch_never_executes_or_publishes_the_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            github_env = root / "github-env"
            github_env.write_text("EXISTING=value\n", encoding="utf-8")
            downloads = []

            def corrupt_download(url, destination):
                downloads.append(Path(destination))
                Path(destination).write_bytes(b"corrupt or replaced installer")

            with patch.object(ci_ssh_features.platform, "system", return_value="Windows"), \
                 patch.dict(os.environ, {"RUNNER_TEMP": directory, "GITHUB_ENV": str(github_env),
                                         "QA_CYGWIN_ROOT": "existing-owned-installation"}), \
                 patch.object(ci_ssh_features.urllib.request, "urlretrieve", side_effect=corrupt_download), \
                 patch.object(ci_ssh_features.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "checksum differs from pinned version"):
                    ci_ssh_features.install()
                run.assert_not_called()
                self.assertEqual(os.environ["QA_CYGWIN_ROOT"], "existing-owned-installation")
            self.assertEqual(github_env.read_text(encoding="utf-8"), "EXISTING=value\n")
            self.assertFalse(downloads[0].parent.exists())

    def test_installer_failure_does_not_publish_the_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            github_env = Path(directory) / "github-env"

            def download(url, destination):
                Path(destination).write_bytes(self.payload)

            with patch.object(ci_ssh_features.platform, "system", return_value="Windows"), \
                 patch.dict(os.environ, {"RUNNER_TEMP": directory, "GITHUB_ENV": str(github_env),
                                         "QA_CYGWIN_ROOT": "existing-owned-installation"}), \
                 patch.object(ci_ssh_features, "CYGWIN_SETUP_SHA256", self.sha256), \
                 patch.object(ci_ssh_features.urllib.request, "urlretrieve", side_effect=download), \
                 patch.object(ci_ssh_features.subprocess, "run", return_value=Mock(returncode=1)) as run:
                with self.assertRaisesRegex(RuntimeError, "package installation failed"):
                    ci_ssh_features.install()
                run.assert_called_once()
                self.assertEqual(os.environ["QA_CYGWIN_ROOT"], "existing-owned-installation")
            self.assertFalse(github_env.exists())


class CygwinSshHomeTest(unittest.TestCase):
    record = "runneradmin:*:197108:197121:QA runner:/home/runneradmin:/bin/bash\n"

    def test_first_login_can_write_its_cookie_before_a_shell_creates_the_home(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home" / "runneradmin"
            self.assertFalse(home.exists())
            with patch("ci_services.command", side_effect=[self.record, str(home)]):
                actual = prepare_cygwin_home(root, "runneradmin")
            self.assertEqual(actual, home.resolve())
            cookie = actual / ".Xauthority"
            cookie.write_bytes(b"forwarded-session-cookie")
            self.assertEqual(cookie.read_bytes(), b"forwarded-session-cookie")

    def test_existing_home_and_cookie_survive_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home" / "runneradmin"
            home.mkdir(parents=True)
            cookie = home / ".Xauthority"
            cookie.write_bytes(b"existing-cookie")
            with patch("ci_services.command", side_effect=[self.record, str(home)]):
                prepare_cygwin_home(root, "RUNNERADMIN")
            self.assertEqual(cookie.read_bytes(), b"existing-cookie")

    def test_home_outside_the_owned_installation_is_rejected_without_creating_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "cygwin"
            personal = Path(directory) / "personal-home"
            with patch("ci_services.command", side_effect=[self.record, str(personal)]):
                with self.assertRaisesRegex(RuntimeError, "job-owned"):
                    prepare_cygwin_home(root, "runneradmin")
            self.assertFalse(personal.exists())

    def test_installation_root_cannot_be_used_as_a_user_home(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch("ci_services.command", side_effect=[self.record, str(root)]):
                with self.assertRaisesRegex(RuntimeError, "job-owned"):
                    prepare_cygwin_home(root, "runneradmin")

    def test_missing_or_malformed_user_record_fails_before_provisioning(self):
        with tempfile.TemporaryDirectory() as directory:
            for records in ("", self.record.replace("runneradmin", "another"),
                            "runneradmin:*:197108:197121:QA runner::/bin/bash\n"):
                with self.subTest(records=records), \
                        patch("ci_services.command", return_value=records) as command:
                    with self.assertRaisesRegex(RuntimeError, "resolve"):
                        prepare_cygwin_home(Path(directory), "runneradmin")
                    self.assertEqual(command.call_count, 1)


if __name__ == "__main__":
    unittest.main()
