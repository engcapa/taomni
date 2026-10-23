"""Protocol helper contracts; these are unit checks, not browser/native evidence."""
import json
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


if __name__ == "__main__": unittest.main()
