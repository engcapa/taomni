"""An application claim cannot substitute for the native writer lock."""
import errno
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from qa_ui_auto.module_profile_observation import _exclusive, writer_lease
from qa_ui_auto.steps import StepError


class ModuleProfileObservationTests(unittest.TestCase):
    def fixture(self, tmp):
        root = Path(tmp).resolve()
        plugins = root / "plugins"
        plugins.mkdir()
        path = root / ".profile-locks/plugins/hello-plugin.lock"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"unchanged lease bytes")
        return plugins, path

    def test_free_writer_is_proven_and_enabled_without_actual_ownership_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugins, path = self.fixture(tmp)
            self.assertFalse(writer_lease(plugins, enabled=False)["held"])
            with self.assertRaisesRegex(StepError, "does not own"):
                writer_lease(plugins, enabled=True)
            self.assertEqual(path.read_bytes(), b"unchanged lease bytes")

    def test_existing_os_lock_is_observed_and_remains_held_until_original_owner_closes(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugins, path = self.fixture(tmp)
            with path.open("r+b") as owner:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(owner.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertTrue(writer_lease(plugins, enabled=True)["held"])
                with self.assertRaisesRegex(StepError, "still holds"):
                    writer_lease(plugins, enabled=False)
                self.assertTrue(writer_lease(plugins, enabled=True)["held"])
            self.assertFalse(writer_lease(plugins, enabled=False)["held"])
            self.assertEqual(path.read_bytes(), b"unchanged lease bytes")

    def test_missing_file_is_never_created_or_accepted_as_enabled_ownership(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugins, path = self.fixture(tmp)
            path.unlink()
            self.assertEqual(writer_lease(plugins, enabled=False), {"exists": False, "held": False})
            with self.assertRaisesRegex(StepError, "no native writer"):
                writer_lease(plugins, enabled=True)
            self.assertFalse(path.exists())

    @unittest.skipIf(os.name == "nt", "Windows link creation requires unrelated privileges")
    def test_linked_lock_file_cannot_select_another_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugins, path = self.fixture(tmp)
            elsewhere = plugins.parent / "elsewhere.lock"
            path.rename(elsewhere)
            path.symlink_to(elsewhere)
            with self.assertRaises(StepError):
                writer_lease(plugins, enabled=True)
            self.assertEqual(elsewhere.read_bytes(), b"unchanged lease bytes")

    def test_an_invalid_descriptor_is_an_error_and_never_a_busy_pass(self):
        descriptor = os.open(os.devnull, os.O_RDWR)
        os.close(descriptor)
        with self.assertRaises(OSError):
            _exclusive(descriptor)

    def test_native_probe_always_releases_its_handle_when_lock_observation_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugins, path = self.fixture(tmp)
            with patch("qa_ui_auto.module_profile_observation._exclusive", side_effect=OSError(errno.EIO, "unit failure")):
                with self.assertRaises(OSError):
                    writer_lease(plugins, enabled=True)
            # Windows refuses unlink if the observation leaked a descriptor.
            path.unlink()
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
