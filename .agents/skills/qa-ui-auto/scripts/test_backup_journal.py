import errno
import json
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.fixtures import backup_journal


def locked(code: int = 5) -> OSError:
    error = PermissionError("Permission denied while replacing journal")
    error.winerror = code
    return error


class BackupJournalTest(TestCase):
    def test_windows_crt_access_denial_without_winerror_retries_current_job(self):
        error = PermissionError(errno.EACCES, "Permission denied", "job.json")
        self.assertIsNone(getattr(error, "winerror", None))
        with patch.object(backup_journal.os, "name", "nt"), \
                patch.object(backup_journal.time, "sleep"):
            path = Mock()
            path.read_text.side_effect = [error, '{"phase":"completed"}']
            self.assertEqual(backup_journal.read_journal(path)["phase"], "completed")
            self.assertEqual(path.read_text.call_count, 2)

    def test_windows_crt_permanent_denial_still_expires(self):
        error = PermissionError(errno.EACCES, "Permission denied", "job.json")
        with patch.object(backup_journal.os, "name", "nt"), \
                patch.object(backup_journal.time, "monotonic", side_effect=[10, 10.5, 12]), \
                patch.object(backup_journal.time, "sleep"):
            path = Mock()
            path.read_text.side_effect = error
            with self.assertRaises(PermissionError):
                backup_journal.read_journal(path)
            self.assertEqual(path.read_text.call_count, 2)

    def test_windows_atomic_replacement_denial_retries_and_reads_current_job(self):
        for code in (5, 32, 33):
            with self.subTest(code=code), patch.object(backup_journal.os, "name", "nt"), \
                    patch.object(backup_journal.time, "sleep"):
                path = Mock()
                path.read_text.side_effect = [locked(code), '{"phase":"completed","localPath":"archive.taobak"}']
                self.assertEqual(backup_journal.read_journal(path)["phase"], "completed")
                self.assertEqual(path.read_text.call_count, 2)

    def test_permanent_denial_expires_instead_of_hiding_failed_observation(self):
        with patch.object(backup_journal.os, "name", "nt"), \
                patch.object(backup_journal.time, "monotonic", side_effect=[10, 10.5, 12]), \
                patch.object(backup_journal.time, "sleep"):
            path = Mock(); path.read_text.side_effect = locked()
            with self.assertRaisesRegex(PermissionError, "Permission denied"):
                backup_journal.read_journal(path)
            self.assertEqual(path.read_text.call_count, 2)

    def test_other_errors_and_posix_denials_fail_immediately(self):
        crt = PermissionError(errno.EACCES, "Permission denied", "job.json")
        unknown = PermissionError(errno.EACCES, "Unexpected native error", "job.json")
        unknown.winerror = 123
        for system, error in (("posix", locked()), ("posix", crt), ("nt", locked(123)),
                              ("nt", unknown), ("nt", FileNotFoundError("missing"))):
            with self.subTest(system=system, error=error), patch.object(backup_journal.os, "name", system):
                path = Mock(); path.read_text.side_effect = error
                with self.assertRaises(type(error)):
                    backup_journal.read_journal(path)
                path.read_text.assert_called_once_with(encoding="utf-8")

    def test_atomic_journal_corruption_and_invalid_shape_never_retry(self):
        for text in ('{"phase":', '[]'):
            with self.subTest(text=text), patch.object(backup_journal.os, "name", "nt"):
                path = Mock(); path.read_text.return_value = text
                with self.assertRaises(ValueError):
                    backup_journal.read_journal(path)
                path.read_text.assert_called_once()
