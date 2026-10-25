"""First-login prerequisites for authenticated Cygwin X11 forwarding."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ci_ssh_features import prepare_cygwin_home


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
