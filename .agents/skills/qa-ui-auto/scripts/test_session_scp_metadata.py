"""Protocol helper contracts; these are unit checks, not browser/native evidence."""
import json
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPER = Path("src-tauri/src/filebrowser/sftp/scp_metadata.py")


class ScpMetadataTests(unittest.TestCase):
    def request(self, operation, *args):
        process = subprocess.run([sys.executable, str(HELPER), json.dumps([operation, args])], capture_output=True, text=True)
        return process.returncode, json.loads(process.stdout)

    def test_names_remain_data_and_recursive_delete_does_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            unusual = base / "a' ; newline\nfile.txt"
            unusual.write_text("retained")
            status, response = self.request("list", root)
            self.assertEqual(status, 0)
            self.assertEqual(response["ok"][0]["name"], unusual.name)
            self.assertEqual(response["ok"][0]["size"], 8)
            alias = base / "alias"
            alias.symlink_to(unusual)
            status, _ = self.request("remove", str(alias), True)
            self.assertEqual(status, 0)
            self.assertTrue(unusual.exists())
            status, _ = self.request("rename", str(unusual), str(base / "renamed"))
            self.assertEqual(status, 0)
            self.assertEqual((base / "renamed").read_text(), "retained")

    def test_errors_are_explicit(self):
        status, response = self.request("stat", "/not-a-taomni-fixture-file")
        self.assertEqual(status, 1)
        self.assertIn("No such file", response["error"])

    def test_fingerprint_binds_resume_prefix_and_complete_content(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            source.write_bytes(b"verified-prefix-and-suffix")
            status, result = self.request("fingerprint", str(source), 15)
            self.assertEqual(status, 0)
            self.assertEqual(result["ok"], dict(size=26,
                sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                prefix=hashlib.sha256(source.read_bytes()[:15]).hexdigest()))

    def test_scp_suffix_framing_and_changed_source_rejection(self):
        helper = HELPER.with_name("scp_source.py")
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            source.write_bytes(b"original-content")
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            result = subprocess.run([sys.executable, str(helper), json.dumps([str(source), 9, digest])],
                input=b"\0\0\0", capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b"C0644 7 payload\ncontent\0")
            source.write_bytes(b"modified-content")
            result = subprocess.run([sys.executable, str(helper), json.dumps([str(source), 9, digest])],
                input=b"\0\0\0", capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stdout.startswith(b"\2Remote file changed"))


if __name__ == "__main__": unittest.main()
