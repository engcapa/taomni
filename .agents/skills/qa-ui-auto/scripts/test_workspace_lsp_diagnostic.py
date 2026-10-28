import os
from pathlib import Path
import unittest
from unittest.mock import patch

from qa_ui_auto.fixtures.workspace_lsp_diagnostic import owned_pid, process_alive


class LspDiagnosticTest(unittest.TestCase):
    @patch("subprocess.check_output")
    def test_selects_only_exact_verified_executable(self, output):
        output.return_value = "12 /qa/taomni\n13 /production/taomni\n"
        self.assertEqual(owned_pid(Path("/qa/taomni")), 12)

    @patch("subprocess.check_output")
    def test_rejects_ambiguous_process_identity(self, output):
        output.return_value = "12 /qa/taomni\n14 /qa/taomni\n"
        with self.assertRaisesRegex(RuntimeError, "Expected one"):
            owned_pid(Path("/qa/taomni"))

    def test_observes_process_without_sending_signal(self):
        self.assertTrue(process_alive(os.getpid()))
        with patch("os.kill", side_effect=ProcessLookupError):
            self.assertFalse(process_alive(99))


if __name__ == "__main__":
    unittest.main()
