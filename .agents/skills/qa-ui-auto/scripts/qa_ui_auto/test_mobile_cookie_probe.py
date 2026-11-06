"""Host PTY marker commands must work across OSes without interpolating paths."""
import base64
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

from .mobile_cookie_probe import marker_command


class MarkerCommandTest(unittest.TestCase):
    def test_posix_marker_uses_real_shell_and_quotes_metacharacters(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / "space 'quote; $(false).txt"
            command = marker_command(marker, windows=False)
            subprocess.run(command, shell=True, check=True)
            self.assertEqual(marker.read_text().strip(), 'QA_COOKIE_GATEWAY_PTY')

    def test_windows_marker_uses_encoded_powershell_from_either_cmd_or_powershell(self):
        marker = Path("C:/QA Reports/owner's folder/marker.txt")
        command = marker_command(marker, windows=True)
        args = shlex.split(command)
        self.assertEqual(args[:5], ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
        script = base64.b64decode(args[5]).decode('utf-16le')
        self.assertEqual(script, "[System.IO.File]::WriteAllText('C:/QA Reports/owner''s folder/marker.txt', 'QA_COOKIE_GATEWAY_PTY')")
        self.assertNotIn(str(marker), command)
