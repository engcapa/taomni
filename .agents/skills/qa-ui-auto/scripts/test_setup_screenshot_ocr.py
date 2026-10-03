import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

import setup_screenshot_ocr as setup


class ScreenshotOcrSetupTest(unittest.TestCase):
    def test_pinned_data_is_verified_and_language_readiness_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            response = MagicMock()
            response.__enter__.return_value.read.return_value = b"language-data"
            checksum = hashlib.sha256(b"language-data").hexdigest()
            with patch.dict(os.environ, {"GITHUB_ENV": str(root / "env")}), \
                 patch.object(setup, "LANGUAGES", {"eng": checksum}), \
                 patch("setup_screenshot_ocr.shutil.which", return_value="tesseract"), \
                 patch("setup_screenshot_ocr.urllib.request.urlopen", return_value=response), \
                 patch("setup_screenshot_ocr.subprocess.check_output", return_value="List of available languages (1):\neng\n") as command:
                setup.provision(root / "data")
                self.assertEqual((root / "data" / "eng.traineddata").read_bytes(), b"language-data")
                self.assertIn("TESSDATA_PREFIX=", (root / "env").read_text())
                self.assertEqual(command.call_args.args[0], ["tesseract", "--list-langs"])

    def test_missing_executable_is_not_ready(self):
        with patch("setup_screenshot_ocr.shutil.which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "executable missing"):
                setup.provision(Path("unused"))
