"""Windows native capture must not silently inherit a Low driver token."""
import os
import sys
import unittest
from unittest.mock import Mock, patch

from native_webdriver_transport import WebDriverError
from native_windows_integrity import ensure_medium_driver_tree, owned_driver_processes, process_integrity, select_driver_processes


class WindowsIntegrityTest(unittest.TestCase):
    def test_recycled_parent_pids_and_browser_sandboxes_are_not_native_adapters(self):
        rows = [(17, 1, "tauri-driver.exe"), (18, 17, "msedgedriver.exe"),
                (19, 18, "taomni.exe"), (20, 19, "msedgewebview2.exe"),
                (21, 17, "fontdrvhost.exe"), (22, 21, "SearchHost.exe"),
                (23, 17, "msedgedriver.exe")]
        births = Mock(side_effect={17: 100, 18: 110, 23: 10}.__getitem__)
        self.assertEqual(select_driver_processes(rows, 17, births),
                         [(17, "tauri-driver.exe"), (18, "msedgedriver.exe")])
        self.assertTrue(all(call.args[0] in {17, 18, 23} for call in births.call_args_list))

    def test_an_absent_root_cannot_adopt_children_of_a_recycled_pid(self):
        births = Mock()
        self.assertEqual(select_driver_processes([(18, 17, "msedgedriver.exe")], 17, births), [])
        births.assert_not_called()

    def test_live_nested_adapter_with_low_token_still_fails_closed(self):
        rows = [(17, 1, "tauri-driver.exe"), (18, 17, "tauri-driver.exe"), (19, 18, "msedgedriver.exe")]
        selected = select_driver_processes(rows, 17, {17: 100, 18: 101, 19: 102}.__getitem__)
        with patch("native_windows_integrity.owned_driver_processes", return_value=selected), \
             patch("native_windows_integrity.process_integrity", side_effect=[8192, 8192, 4096]):
            with self.assertRaisesRegex(WebDriverError, "below Medium Integrity.*msedgedriver.exe"):
                ensure_medium_driver_tree(17)

    def test_medium_driver_tree_preserves_process_evidence(self):
        with patch("native_windows_integrity.owned_driver_processes", return_value=[
                (17, "tauri-driver.exe"), (18, "msedgedriver.exe")]), \
             patch("native_windows_integrity.process_integrity", side_effect=[8192, 8192]):
            evidence = ensure_medium_driver_tree(17)
        self.assertEqual([row["integrityRid"] for row in evidence], [8192, 8192])
        self.assertEqual(evidence[1]["pid"], 18)

    def test_low_native_adapter_is_rejected_even_when_parent_is_medium(self):
        with patch("native_windows_integrity.owned_driver_processes", return_value=[
                (17, "tauri-driver.exe"), (18, "msedgedriver.exe")]), \
             patch("native_windows_integrity.process_integrity", side_effect=[8192, 4096]):
            with self.assertRaisesRegex(WebDriverError, "below Medium Integrity.*msedgedriver.exe") as raised:
                ensure_medium_driver_tree(17)
        self.assertIn("0x80070005", str(raised.exception))
        self.assertIn("No ACL, privacy setting or process token was changed", str(raised.exception))

    def test_disappeared_or_unreadable_owned_processes_fail_actionably(self):
        with patch("native_windows_integrity.owned_driver_processes", return_value=[]):
            with self.assertRaisesRegex(WebDriverError, "disappeared"):
                ensure_medium_driver_tree(17)
        with patch("native_windows_integrity.owned_driver_processes", return_value=[(17, "driver.exe")]), \
             patch("native_windows_integrity.process_integrity", side_effect=OSError("access denied")):
            with self.assertRaisesRegex(WebDriverError, "Cannot inspect.*access denied"):
                ensure_medium_driver_tree(17)

    @unittest.skipUnless(sys.platform == "win32", "Windows process token API")
    def test_native_api_reads_current_owned_process(self):
        self.assertGreater(process_integrity(os.getpid()), 0)
        self.assertIn(os.getpid(), [pid for pid, _ in owned_driver_processes(os.getpid())])


if __name__ == "__main__":
    unittest.main()
