"""Windows native capture must not silently inherit a Low driver token."""
import os
import sys
import unittest
from unittest.mock import patch

from native_webdriver_transport import WebDriverError
from native_windows_integrity import ensure_medium_driver_tree, owned_driver_processes, process_integrity


class WindowsIntegrityTest(unittest.TestCase):
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
