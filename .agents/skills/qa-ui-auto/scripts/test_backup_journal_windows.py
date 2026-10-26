"""Real Windows sharing violations at the independent journal reader boundary."""
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import errno
import json
import os
from pathlib import Path
import tempfile
from unittest import TestCase, skipUnless
from unittest.mock import patch

from qa_ui_auto.fixtures import backup_journal


@skipUnless(os.name == "nt", "Requires actual Windows file sharing semantics")
class WindowsBackupJournalTest(TestCase):
    @contextmanager
    def exclusive_reader(self, path):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
            wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
            wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.CreateFileW(str(path), 0x80000000, 0, None, 3, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())

        def release():
            nonlocal handle
            if handle is not None:
                if not kernel.CloseHandle(handle):
                    raise ctypes.WinError(ctypes.get_last_error())
                handle = None

        try:
            yield release
        finally:
            release()

    def test_actual_crt_reader_denial_recovers_after_handle_release(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "job.json"
            job = {"phase": "completed", "localPath": "archive.taobak"}
            path.write_text(json.dumps(job), encoding="utf-8")
            with self.exclusive_reader(path) as release:
                with self.assertRaises(PermissionError) as caught:
                    path.read_text(encoding="utf-8")
                self.assertEqual(caught.exception.errno, errno.EACCES)
                self.assertIsNone(getattr(caught.exception, "winerror", None))
                print("Actual Windows CRT journal denial: errno=13, winerror=None")
                with patch.object(backup_journal.time, "sleep",
                                  side_effect=lambda _: release()) as backoff:
                    self.assertEqual(backup_journal.read_journal(path), job)
                backoff.assert_called_once_with(0.02)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), job)

    def test_persistent_actual_lock_expires_without_accepting_a_journal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "job.json"
            job = {"phase": "packing", "revision": 1}
            path.write_text(json.dumps(job), encoding="utf-8")
            with self.exclusive_reader(path):
                with patch.object(backup_journal.time, "sleep",
                                  wraps=backup_journal.time.sleep) as backoff:
                    with self.assertRaises(PermissionError):
                        backup_journal.read_journal(path, timeout_sec=0.04)
                    self.assertGreater(backoff.call_count, 0)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), job)
