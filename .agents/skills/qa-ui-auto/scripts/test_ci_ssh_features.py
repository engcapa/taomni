"""SCP receipt paths must address the server's real host filesystem."""
from pathlib import Path, PureWindowsPath
import tempfile
import unittest

from ci_ssh_features import transfer_paths


class TransferPathsTest(unittest.TestCase):
    def test_cygwin_protocol_path_is_not_a_windows_disk_path(self):
        remote = PureWindowsPath("D:/qa-cygwin/home/runneradmin/taomni-qa-ssh-features")
        local = PureWindowsPath("C:/Users/runneradmin/AppData/Local/Temp/qa/local")
        paths = transfer_paths(remote, "/home/runneradmin/taomni-qa-ssh-features", local)

        self.assertEqual(paths["remote_dir"], "/home/runneradmin/taomni-qa-ssh-features")
        self.assertEqual(paths["source"], "/home/runneradmin/taomni-qa-ssh-features/scp-source.txt")
        self.assertEqual(paths["uploaded"], "D:/qa-cygwin/home/runneradmin/taomni-qa-ssh-features/scp-upload.txt")
        self.assertEqual(paths["downloaded"], "C:/Users/runneradmin/AppData/Local/Temp/qa/local/scp-source.txt")
        self.assertTrue(PureWindowsPath(paths["uploaded"]).is_absolute())
        self.assertFalse(PureWindowsPath(paths["remote_dir"]).is_absolute())

    def test_host_receipts_read_the_actual_files_with_distinct_ssh_namespace(self):
        with tempfile.TemporaryDirectory() as directory:
            remote = Path(directory) / "server"
            local = Path(directory) / "client"
            remote.mkdir()
            local.mkdir()
            (remote / "scp-upload.txt").write_bytes(b"qa-scp-upload\n")
            (local / "scp-source.txt").write_bytes(b"qa-scp-roundtrip\n")
            paths = transfer_paths(remote, "/home/tester/fixture", local)
            self.assertEqual(Path(paths["uploaded"]).read_bytes(), b"qa-scp-upload\n")
            self.assertEqual(Path(paths["downloaded"]).read_bytes(), b"qa-scp-roundtrip\n")
            self.assertEqual(paths["source"], "/home/tester/fixture/scp-source.txt")


if __name__ == "__main__":
    unittest.main()
