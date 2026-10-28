"""Exercise the independent SDK child fixture; no browser or native app is launched."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from qa_ui_auto.fixtures.workspace_slow_sdk import build_probe


class HeldSdkProbeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="held-sdk-test-")
        cls.root = Path(cls.directory.name) / "sdk"
        cls.manifest = build_probe(cls.root)
        cls.binary = next((cls.root / "bin").glob("java*"))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        (self.root / "release").unlink(missing_ok=True)
        (self.root / "events.jsonl").write_text("")
        (self.root / "mode").write_text("normal")

    def wait_for_started(self, process):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            events = (self.root / "events.jsonl").read_text().splitlines()
            if events:
                event = json.loads(events[0])
                self.assertEqual(event["phase"], "started")
                self.assertEqual(event["pid"], process.pid)
                self.assertGreater(event["epochMs"], 0)
                return
            time.sleep(.01)
        self.fail("SDK child did not report start")

    def run_probe(self, mode):
        (self.root / "mode").write_text(mode)
        with subprocess.Popen([str(self.binary), "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            try:
                self.wait_for_started(process)
                time.sleep(.05)
                self.assertIsNone(process.poll(), "Probe returned before release; it cannot prove pending SDK work")
                self.assertNotIn("released", (self.root / "events.jsonl").read_text())
                (self.root / "release").write_text("release")
                stdout, stderr = process.communicate(timeout=5)
                return process.returncode, stdout.decode(), stderr.decode()
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)

    def test_real_child_waits_then_reports_java_version_and_binary_provenance(self):
        code, stdout, stderr = self.run_probe("normal")
        self.assertEqual(code, 0)
        self.assertEqual(stdout, "")
        self.assertIn('openjdk version "21.0.8"', stderr)
        self.assertIn('"phase":"released"', (self.root / "events.jsonl").read_text())
        self.assertEqual(self.manifest["binarySha256"], hashlib.sha256(self.binary.read_bytes()).hexdigest())
        self.assertTrue((self.root / "compile.log").is_file())

    def test_actual_process_failure_is_retained_and_never_returned_as_a_version(self):
        code, _, stderr = self.run_probe("error")
        self.assertEqual(code, 1)
        self.assertIn("version probe failed", stderr)
        self.assertNotIn("openjdk version", stderr)
        self.assertIn('"phase":"rejected"', (self.root / "events.jsonl").read_text())

    def test_other_program_invocations_fail_explicitly(self):
        result = subprocess.run([str(self.binary), "--unexpected"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("openjdk version", result.stderr)


if __name__ == "__main__":
    unittest.main()
