import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
import subprocess

from qa_ui_auto import native_diagnostics


class NativeDiagnosticsTest(TestCase):
    def test_windows_diagnostic_timeout_is_recorded_without_raising(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
                patch.object(native_diagnostics.platform, "system", return_value="Windows"), \
                patch.object(native_diagnostics.subprocess, "run", side_effect=subprocess.TimeoutExpired("pwsh.exe", 5)):
            root = Path(directory)
            native_diagnostics.collect(root, root, failed=True)

            errors = json.loads((root / "native-diagnostics/windows-diagnostics-errors.json").read_text())
            self.assertEqual(len(errors), 3)
            self.assertEqual({entry["diagnostic"] for entry in errors}, {
                "processes", "webview-profile", "desktop",
            })

    def test_windows_profile_diagnostic_is_not_recursive(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
                patch.object(native_diagnostics.platform, "system", return_value="Windows"), \
                patch.object(native_diagnostics.subprocess, "run") as run:
            root = Path(directory)
            native_diagnostics.collect(root, root, failed=True)

            scripts = [call.args[0][3] for call in run.call_args_list]
            self.assertEqual(len(scripts), 3)
            self.assertNotIn("-Recurse", scripts[1])
            self.assertTrue(all(call.kwargs["timeout"] == 5 for call in run.call_args_list))
