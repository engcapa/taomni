"""Win32 process exit races without requiring an interactive desktop."""
from ctypes import cast, POINTER, wintypes
from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.rdp_helpers.mstsc import MstscProcess


class MstscProcessTerminationTest(TestCase):
    def setUp(self):
        self.api = Mock()
        self.process = MstscProcess(self.api, 123, 456)

    def exit_code(self, value):
        def query(_handle, result):
            cast(result, POINTER(wintypes.DWORD)).contents.value = value
            return True
        self.api.GetExitCodeProcess.side_effect = query

    def terminate_with_error(self, error):
        self.api.TerminateProcess.return_value = False
        with patch("ctypes.get_last_error", return_value=error, create=True), \
                patch("ctypes.WinError", side_effect=lambda code: OSError(code, "Win32 failure"), create=True):
            self.process.terminate()

    def test_terminated_client_can_exit_between_wait_timeout_and_kill(self):
        # taskkill/ProcDump may finish the owned client before the final kill.
        self.exit_code(1)
        self.terminate_with_error(5)
        self.api.TerminateProcess.assert_called_once_with(123, 1)
        self.api.CloseHandle.assert_not_called()

    def test_clean_exit_in_the_same_race_is_also_accepted(self):
        self.exit_code(0)
        self.terminate_with_error(5)

    def test_access_denied_for_a_still_running_client_is_reported(self):
        self.exit_code(259)
        with self.assertRaises(OSError) as raised:
            self.terminate_with_error(5)
        self.assertEqual(raised.exception.errno, 5)

    def test_other_termination_errors_are_not_hidden_by_a_process_exit(self):
        self.exit_code(1)
        with self.assertRaises(OSError) as raised:
            self.terminate_with_error(6)
        self.assertEqual(raised.exception.errno, 6)
        self.api.GetExitCodeProcess.assert_not_called()

    def test_successful_termination_preserves_handle_ownership(self):
        self.api.TerminateProcess.return_value = True
        self.process.kill()
        self.api.GetExitCodeProcess.assert_not_called()
        self.api.CloseHandle.assert_not_called()
