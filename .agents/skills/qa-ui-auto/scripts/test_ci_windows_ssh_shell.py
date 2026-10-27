import os
from pathlib import Path
import tempfile
from unittest import TestCase
from unittest.mock import patch

from ci_services import Services, configure_windows_ssh_shell


class WindowsSshShellTest(TestCase):
    def test_missing_shell_fails_before_registry_mutation(self):
        with tempfile.TemporaryDirectory() as directory, patch("ci_services.powershell") as run:
            with self.assertRaisesRegex(RuntimeError, "SSH shell is missing"):
                configure_windows_ssh_shell(Path(directory) / "missing.exe")
            run.assert_not_called()

    def test_shell_path_is_environment_data_instead_of_powershell_code(self):
        with tempfile.TemporaryDirectory() as directory, patch("ci_services.powershell") as run, \
                patch.dict(os.environ):
            shell = Path(directory) / "space and ' apostrophe.exe"
            shell.touch()
            configure_windows_ssh_shell(shell)
            self.assertEqual(os.environ["QA_SSH_DEFAULT_SHELL"], str(shell))
            script = run.call_args.args[0]
            self.assertIn("-Value $env:QA_SSH_DEFAULT_SHELL", script)
            self.assertNotIn(str(shell), script)
            self.assertIn("DefaultShellCommandOption", script)

    def test_diagnostic_override_is_explicit_and_does_not_change_normal_services(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(Services(Path(directory), {"ssh"}, {}).ssh_windows_shell)
            shell = Path(directory) / "bash.exe"
            diagnostic = Services(Path(directory), {"ssh"}, {}, ssh_windows_shell=shell)
            self.assertEqual(diagnostic.ssh_windows_shell, shell)
