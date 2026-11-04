import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
import subprocess

from qa_ui_auto import native_diagnostics


class NativeDiagnosticsTest(TestCase):
    def test_worker_state_raw_logs_are_private_but_ordinary_app_logs_are_collected(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
                patch.object(native_diagnostics.platform, "system", return_value="Linux"):
            root = Path(directory)
            case = root / "TC-ORCH-WORKER-004"
            case.mkdir()
            secret = "fixture-private-worker-secret-must-not-publish"
            ordinary = []
            for name in ("native-appdata", "native-appcache", "native-appconfig"):
                app = root / name / "com.taomni.app.qa"
                private = app / "orchestration" / "worker-state" / "run-owned"
                paths = [private / "harness.stderr.log", private / "home" / "logs" / "nested.log",
                         private / "home" / "cache" / "tool.log"]
                for path in paths:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(secret)
                log = app / "logs" / "taomni.log"
                log.parent.mkdir(parents=True)
                log.write_text("ordinary QA application diagnostic\n")
                ordinary.append((name, log.relative_to(root / name)))
                webview = app / "webview" / "Default" / "000001.log"
                webview.parent.mkdir(parents=True)
                webview.write_text(secret)
            native_diagnostics.collect(case, root, failed=False)
            destination = case / "native-diagnostics"
            collected = [path for path in destination.rglob("*") if path.is_file()]
            self.assertEqual(len(collected), 3)
            self.assertTrue(all(secret not in path.read_text() for path in collected))
            for name, relative in ordinary:
                self.assertEqual((destination / ("logs-" + name) / relative).read_text(),
                                 "ordinary QA application diagnostic\n")
            self.assertFalse(any("worker-state" in path.parts or "webview" in path.parts for path in collected))
            # Collection does not mutate/delete private source logs or remove
            # already bound artifacts after the runner receipt is generated.
            self.assertEqual((root / "native-appdata" / "com.taomni.app.qa" / "orchestration" /
                              "worker-state" / "run-owned" / "harness.stderr.log").read_text(), secret)

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
