"""File assertions wait for publication without hiding persistent read failures."""

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.native_steps import _assert_file_contains
from qa_ui_auto.steps import StepError


class FileContainsRetryTest(TestCase):
    def test_atomic_replace_access_conflict_then_real_saved_bytes(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "backup_policy.json"
            path.write_text('{"autoBackupEnabled": false}', encoding="utf-8")
            read_text = Path.read_text
            attempts = 0

            def read_after_replace(target, *args, **kwargs):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise PermissionError(13, "Permission denied", str(target))
                return read_text(target, *args, **kwargs)

            with patch.object(Path, "read_text", read_after_replace), \
                 patch("qa_ui_auto.native_steps.time.sleep"):
                result = _assert_file_contains(Mock(), {
                    "path": str(path), "contains": '"autoBackupEnabled": false',
                })
            self.assertIn("disk verified", result)
            self.assertEqual(attempts, 2)

    def test_persistent_access_failure_retains_error_and_fails_at_deadline(self):
        with patch.object(Path, "read_text", side_effect=PermissionError(13, "Permission denied")), \
             patch("qa_ui_auto.native_steps.time.monotonic", side_effect=[0, 0, 0.3, 1]), \
             patch("qa_ui_auto.native_steps.time.sleep"), \
             self.assertRaisesRegex(StepError, "PermissionError.*Permission denied"):
            _assert_file_contains(Mock(), {"path": "policy.json", "contains": "false", "timeout_sec": 1})

    def test_missing_then_wrong_content_does_not_count_as_pass(self):
        with patch.object(Path, "read_text", side_effect=[FileNotFoundError("replacing"), "old value"]), \
             patch("qa_ui_auto.native_steps.time.monotonic", side_effect=[0, 0, 0.3, 1]), \
             patch("qa_ui_auto.native_steps.time.sleep"), \
             self.assertRaisesRegex(StepError, "len=9.*does not contain 'new value'"):
            _assert_file_contains(Mock(), {"path": "policy.json", "contains": "new value", "timeout_sec": 1})

    def test_unrelated_io_error_is_not_retried(self):
        with patch.object(Path, "read_text", side_effect=IsADirectoryError("directory")), \
             self.assertRaises(IsADirectoryError):
            _assert_file_contains(Mock(), {"path": "directory", "contains": "value"})
