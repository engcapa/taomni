"""Account isolation and partial-setup cleanup for the hosted POSIX PTY probe."""
import os
from pathlib import Path
import tempfile
from unittest import TestCase
from unittest.mock import patch

from ci_services import Services
from ci_windows_posix_ssh import start


class WindowsPosixSshTest(TestCase):
    def test_local_invocation_cannot_mutate_accounts(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), \
                patch("ci_services.powershell") as powershell:
            with self.assertRaisesRegex(RuntimeError, "GitHub hosted"):
                start(None, "not-an-account-password")
            powershell.assert_not_called()

    def test_unknown_runtime_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown Windows SSH runtime"):
            Services(Path("unused"), {"ssh"}, {}, ssh_windows_runtime="unknown")

    def prepare(self, directory):
        root = Path(directory) / "cygwin"
        (root / "usr/sbin").mkdir(parents=True)
        (root / "usr/sbin/sshd.exe").touch()
        (root / "etc").mkdir()
        (root / "etc/passwd").write_text("existing:*:1:1::/home/existing:/bin/bash\n")
        services = Services(Path(directory) / "report", {"ssh"}, {}, ssh_windows_runtime="cygwin")
        services.root.mkdir()
        services.private = Path(directory) / "private"
        services.private.mkdir()
        return root, services

    def commands(self, services, events):
        def run(argv):
            name = Path(str(argv[0])).name
            if name == "mkpasswd.exe":
                return f"{services.namespace}:*:1001:100:Disposable:/wrong/home:/bin/sh\n"
            if name == "cygpath.exe":
                return str(argv[-1])
            if name == "ssh-keygen.exe":
                Path(argv[-1]).touch()
            if name == "taskkill":
                events.append("process-stop")
            return ""
        return run

    def test_password_service_keeps_credentials_out_of_config_and_cleans_up_in_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root, services = self.prepare(directory)
            passwd = root / "etc/passwd"
            original = passwd.read_bytes()
            events = []

            def powershell(script):
                self.assertNotIn("disposable-secret", script)
                if "Remove-LocalUser" in script:
                    events.append("account-remove")
                    return ""
                return "1234" if "-PassThru" in script else ""

            with patch.dict(os.environ, GITHUB_ACTIONS="true", QA_CYGWIN_ROOT=str(root),
                            QA_SSH_PASSWORD="disposable-secret"), \
                    patch("ci_services.command", side_effect=self.commands(services, events)), \
                    patch("ci_services.powershell", side_effect=powershell):
                user, port, remote = start(services, "disposable-secret")
                self.assertTrue(os.environ["PATH"].startswith(str(root / "bin") + os.pathsep))
                self.assertEqual(user, services.namespace)
                self.assertGreater(port, 0)
                self.assertEqual(remote, f"/home/{user}/qa-temp")
                text = (services.private / "posix-ssh/sshd_config").read_text()
                self.assertIn("PasswordAuthentication yes", text)
                self.assertIn("PubkeyAuthentication no", text)
                self.assertIn("ListenAddress 127.0.0.1", text)
                self.assertNotIn("disposable-secret", text)
                self.assertIn(f"/home/{user}:/bin/bash", passwd.read_text())
                services.stack.close()
            self.assertEqual(passwd.read_bytes(), original)
            self.assertFalse((root / "home" / user).exists())
            self.assertEqual(events, ["process-stop", "account-remove"])

    def test_failed_account_resolution_still_removes_owned_user(self):
        with tempfile.TemporaryDirectory() as directory:
            root, services = self.prepare(directory)
            original = (root / "etc/passwd").read_bytes()
            with patch.dict(os.environ, GITHUB_ACTIONS="true", QA_CYGWIN_ROOT=str(root)), \
                    patch("ci_services.command", return_value="malformed record"), \
                    patch("ci_services.powershell") as powershell:
                with self.assertRaisesRegex(RuntimeError, "resolve"):
                    start(services, "disposable-secret")
                services.stack.close()
                self.assertIn("Remove-LocalUser", powershell.call_args.args[0])
            self.assertEqual((root / "etc/passwd").read_bytes(), original)
