import ctypes
import os
from pathlib import Path
import platform
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase, skipUnless
from unittest.mock import Mock, patch

from qa_ui_auto import native_processes
from qa_ui_auto.steps import StepError


class NativeProcessSnapshotTest(TestCase):
    def test_windows_snapshot_uses_an_independent_native_enumerator(self):
        rows = [{"pid": 12, "parent": 10, "executable": "C:/qa/Taomni QA.exe"}]
        with patch("qa_ui_auto.native_processes.platform.system", return_value="Windows"), \
                patch("qa_ui_auto.native_processes.windows_snapshot", return_value=rows, create=True) as read, \
                patch("qa_ui_auto.native_processes.subprocess.run", return_value=Mock(
                    stdout='[{"ProcessId":12,"ParentProcessId":10,"ExecutablePath":"C:/qa/Taomni QA.exe"}]')) as run:
            self.assertEqual(native_processes.snapshot(), rows)
        read.assert_called_once_with()
        run.assert_not_called()

    def kernel(self, rows):
        kernel = Mock()
        kernel.CreateToolhelp32Snapshot.return_value = 900
        kernel.GetLastError.return_value = 18
        remaining = iter(rows)

        def next_process(handle, pointer):
            row = next(remaining, None)
            if row is None:
                kernel.GetLastError.return_value = 18
                return False
            entry = ctypes.cast(pointer, ctypes.POINTER(native_processes._WindowsProcessEntry)).contents
            entry.th32ProcessID, entry.th32ParentProcessID = row["pid"], row["parent"]
            return True

        def image(process, flags, buffer, length):
            row = next(row for row in rows if row["pid"] + 1000 == process)
            if row.get("executable") is None:
                return False
            buffer.value = row["executable"]
            return True

        kernel.Process32FirstW.side_effect = next_process
        kernel.Process32NextW.side_effect = next_process
        kernel.OpenProcess.side_effect = lambda access, inherit, pid: pid + 1000
        kernel.QueryFullProcessImageNameW.side_effect = image
        return kernel

    def test_win32_reader_retains_parent_unicode_path_and_unreadable_pid(self):
        rows = [{"pid": 12, "parent": 10, "executable": "C:/qa/中文/Taomni QA.exe"},
                {"pid": 13, "parent": 12, "executable": None}]
        kernel = self.kernel(rows)
        self.assertEqual(native_processes.windows_snapshot(kernel), rows)
        self.assertEqual([call.args[0] for call in kernel.CloseHandle.call_args_list], [1012, 1013, 900])

    def test_win32_access_denied_keeps_the_pid_without_an_executable(self):
        rows = [{"pid": 12, "parent": 10, "executable": None}]
        kernel = self.kernel(rows)
        kernel.OpenProcess.side_effect = None
        kernel.OpenProcess.return_value = None
        self.assertEqual(native_processes.windows_snapshot(kernel), rows)
        kernel.QueryFullProcessImageNameW.assert_not_called()
        kernel.CloseHandle.assert_called_once_with(900)

    def test_win32_snapshot_failure_is_an_error(self):
        kernel = self.kernel([])
        kernel.CreateToolhelp32Snapshot.return_value = ctypes.c_void_p(-1).value
        kernel.GetLastError.return_value = 5
        with self.assertRaisesRegex(StepError, "snapshot failed"):
            native_processes.windows_snapshot(kernel)
        kernel.CloseHandle.assert_not_called()

    def test_win32_enumeration_failure_closes_snapshot_and_fails(self):
        kernel = self.kernel([])
        kernel.Process32FirstW.side_effect = None
        kernel.Process32FirstW.return_value = False
        kernel.GetLastError.return_value = 24
        with self.assertRaisesRegex(StepError, "enumeration failed"):
            native_processes.windows_snapshot(kernel)
        kernel.CloseHandle.assert_called_once_with(900)

    @skipUnless(platform.system() == "Windows", "Win32 process API")
    def test_real_snapshot_identifies_the_unit_process_and_parent(self):
        rows = native_processes.snapshot()
        own = [row for row in rows if row["pid"] == os.getpid()]
        self.assertEqual(len(own), 1)
        self.assertEqual(own[0]["parent"], os.getppid())
        self.assertEqual(Path(own[0]["executable"]).resolve(), Path(sys.executable).resolve())

    def test_unknown_executable_for_the_observed_pid_cannot_prove_exit(self):
        app = {"pid": 12, "parent": 10, "executable": "/qa/taomni"}
        session = SimpleNamespace(_harness=SimpleNamespace(driver=SimpleNamespace(proc=SimpleNamespace(pid=10))),
                                  _app_exit_observed=False)
        with TemporaryDirectory() as directory, \
                patch("qa_ui_auto.native_processes.snapshot", return_value=[{**app, "executable": None}]), \
                patch("qa_ui_auto.native_processes.time.monotonic", side_effect=[0, 0, 16]), \
                patch("qa_ui_auto.native_processes.time.sleep"):
            ctx = SimpleNamespace(session=session, _app_processes=[app], case_dir=Path(directory))
            with self.assertRaisesRegex(StepError, "did not reach process state exited"):
                native_processes.observe(ctx, {"state": "exited"})
            self.assertFalse(session._app_exit_observed)
