from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase


class ShellSftpServiceTest(TestCase):
    def test_real_protocol_authentication_byte_roundtrip_fstat_and_hidden_paths(self):
        import paramiko
        from qa_ui_auto.shell_sftp_service import ShellSftpServer
        with TemporaryDirectory() as directory:
            endpoint = ShellSftpServer(directory, bytes_per_sec=1024 * 1024)
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                client.connect("127.0.0.1", port=endpoint.port, username="qa", password=endpoint.password,
                               look_for_keys=False, allow_agent=False, timeout=5)
                with client.open_sftp() as sftp:
                    self.assertEqual(sftp.normalize("."), "/")
                    sftp.mkdir("/.hidden")
                    self.assertEqual(sftp.normalize("/.hidden"), "/.hidden")
                    payload = bytes(range(256)) * 4
                    with sftp.open("/.hidden/中文.bin", "wb") as handle:
                        handle.write(payload)
                        handle.flush()
                        self.assertEqual(handle.stat().st_size, len(payload))
                    self.assertEqual((endpoint.remote / ".hidden/中文.bin").read_bytes(), payload)
                    with sftp.open("/.hidden/中文.bin", "rb") as handle:
                        self.assertEqual(handle.read(), payload)
                    self.assertEqual(sftp.stat("/.hidden/中文.bin").st_size, len(payload))
                    sftp.rename("/.hidden/中文.bin", "/renamed.bin")
                    sftp.remove("/renamed.bin")
                    sftp.rmdir("/.hidden")
                receipts = (Path(directory) / "sftp-service-bytes.jsonl").read_text()
                self.assertIn('"write"', receipts)
                self.assertIn('"read"', receipts)
                self.assertNotIn(endpoint.password, receipts)
            finally:
                client.close()
                endpoint.stop()
            self.assertFalse(endpoint.thread.is_alive())

    def test_ci_fixture_discovery_does_not_import_the_protocol_dependency(self):
        import subprocess
        import sys
        probe = "import qa_ui_auto.fixtures, sys; assert 'paramiko' not in sys.modules"
        subprocess.run([sys.executable, "-c", probe], check=True, capture_output=True)
