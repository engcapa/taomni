import json
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.native_processes import stop_windows_profile_owners, windows_profile_owners


class WindowsProfileCleanupTest(TestCase):
    def row(self, pid, profile, name="msedgewebview2.exe"):
        return {"ProcessId": pid, "Name": name, "CommandLine": f'webview --user-data-dir="{profile}" --other=1',
                "CreationDate": "12345"}

    def test_only_exact_run_profile_or_its_ebwebview_directory_is_owned(self):
        profile = Path("D:/qa/run/native-appdata/com.taomni.app.qa/webview")
        owned = self.row(11, str(profile))
        child = self.row(12, str(profile) + "/EBWebView")
        rows = [owned, child, self.row(21, str(profile) + "-personal"),
                self.row(22, "D:/personal/com.taomni.app/webview"), self.row(23, str(profile), "chrome.exe"),
                {"ProcessId": 24, "Name": "msedgewebview2.exe", "CommandLine": None}]
        self.assertEqual(windows_profile_owners(rows, profile), [owned, child])

    def test_cleanup_rechecks_creation_identity_and_waits_for_owned_processes_to_exit(self):
        profile = Path("D:/qa/run/native-appdata/com.taomni.app.qa/webview")
        owned = self.row(11, str(profile))
        other = self.row(21, "D:/personal/webview")
        replies = [Mock(stdout=json.dumps([owned, other])), Mock(stdout=""),
                   Mock(stdout=json.dumps(owned)), Mock(stdout=json.dumps(other))]
        with patch("qa_ui_auto.native_processes.subprocess.run", side_effect=replies) as run, \
                patch("qa_ui_auto.native_processes.time.sleep") as sleep:
            self.assertEqual(stop_windows_profile_owners(profile), [11])
        termination = run.call_args_list[1]
        self.assertEqual(termination.kwargs["env"]["QA_OWNED_WEBVIEW_PID"], "11")
        self.assertEqual(termination.kwargs["env"]["QA_OWNED_WEBVIEW_CREATED"], "12345")
        self.assertIn("CreationDate.ToUniversalTime().Ticks", termination.args[0][-1])
        self.assertNotIn("Stop-Process -Name", termination.args[0][-1])
        sleep.assert_called_once_with(.1)
