"""Owned Cygwin home preparation and native SCP receipt paths."""
from pathlib import Path, PureWindowsPath
import tempfile
import unittest
from unittest.mock import patch

from ci_ssh_features import prepare_cygwin_home, transfer_paths


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
