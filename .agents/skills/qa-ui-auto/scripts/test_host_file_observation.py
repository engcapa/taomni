"""Disk observations must not manufacture a Windows save failure."""

import hashlib
import os
from pathlib import Path
import tempfile
from unittest import TestCase, skipUnless
from unittest.mock import patch

from qa_ui_auto import host_file_observation as observation
from qa_ui_auto.steps import StepError


class HostObservationTest(TestCase):
    def test_hashes_every_byte_and_rejects_the_wrong_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large.txt"
            data = b"\x00\xff\r\n" * (1024 * 256)
            path.write_bytes(data)
            self.assertIn(hashlib.sha256(data).hexdigest(), observation.assert_file_sha256(
                None, {"path": str(path), "equals": hashlib.sha256(data).hexdigest()},
            ))
            with patch.object(observation.time, "sleep"), \
                 patch.object(observation.time, "time", side_effect=[0, 0, 2]), \
                 self.assertRaisesRegex(StepError, "hash .* !="):
                observation.assert_file_sha256(None, {
                    "path": str(path), "equals": "0" * 64, "timeout_sec": 1,
                })

    def test_replacement_while_observing_retains_old_snapshot_and_reads_new_next_time(self):
        with tempfile.TemporaryDirectory() as directory:
            path, pending = Path(directory) / "document.txt", Path(directory) / "pending.txt"
            path.write_bytes(b"old complete document")
            pending.write_bytes(b"new complete document")
            with observation.open_observation(path) as reader:
                os.replace(pending, path)
                self.assertEqual(reader.read(), b"old complete document")
            with observation.open_observation(path) as reader:
                self.assertEqual(reader.read(), b"new complete document")
            self.assertFalse(pending.exists())

    def test_observer_releases_its_handle_even_if_hashing_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "document.txt"
            path.write_bytes(b"document")
            with self.assertRaisesRegex(RuntimeError, "hashing failed"):
                with observation.open_observation(path) as reader:
                    raise RuntimeError("hashing failed")
            self.assertTrue(reader.closed)
            path.unlink()

    @skipUnless(os.name == "nt", "real Win32 sharing contract runs on GitHub Windows")
    def test_old_python_reader_reproduces_denial_but_the_observer_allows_atomic_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            path, pending = Path(directory) / "document.txt", Path(directory) / "pending.txt"
            path.write_bytes(b"old")
            pending.write_bytes(b"new")
            with path.open("rb"):
                with self.assertRaises(PermissionError):
                    os.replace(pending, path)
                self.assertEqual(path.read_bytes(), b"old")
            with observation.open_observation(path) as reader:
                os.replace(pending, path)
                self.assertEqual(reader.read(), b"old")
            self.assertEqual(path.read_bytes(), b"new")
