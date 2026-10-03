"""Cross-platform checkout identity must retain real source changes."""
from pathlib import Path
import subprocess
import tempfile
import unittest

from qa_ui_auto.provenance import input_digest, source_identity


class CheckoutIdentityTest(unittest.TestCase):
    def test_crlf_in_all_git_text_formats_is_equivalent(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ("LICENSE", "api.proto", "Main.java", "Info.plist", "build.gradle"):
                path = Path(directory) / name
                path.write_bytes(b"first\nsecond\n")
                original = input_digest(path)
                path.write_bytes(b"first\r\nsecond\r\n")
                self.assertEqual(original, input_digest(path), name)
                path.write_bytes(b"first\r\nchanged\r\n")
                self.assertNotEqual(original, input_digest(path), name)

    def test_binary_line_endings_are_not_normalized(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "binary"
            path.write_bytes(b"\x00\r\n")
            original = input_digest(path)
            path.write_bytes(b"\x00\n")
            self.assertNotEqual(original, input_digest(path))

    def test_new_untracked_source_invalidates_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            before = source_identity(root)
            (root / "src").mkdir()
            (root / "src/new.ts").write_text("export const changed = true;\n")
            self.assertNotEqual(before, source_identity(root))


if __name__ == "__main__":
    unittest.main()
