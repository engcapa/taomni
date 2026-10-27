from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from native_application_shutdown import linux_storage_processes, wait_for_application_shutdown


class NativeShutdownTest(unittest.TestCase):
    def test_snapshot_excludes_the_adapter_and_foreign_process_groups(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for pid, group, name in [(1, 50, "taomni"), (2, 50, "WebKitNetworkProcess"),
                                     (3, 50, "WebKitWebDriver"), (4, 60, "WebKitNetworkProcess")]:
                entry = root / str(pid)
                entry.mkdir()
                binary = root / name
                binary.touch()
                (entry / "exe").symlink_to(binary)
                fields = ["S", "0", str(group)] + ["0"] * 16 + [str(pid * 100)]
                (entry / "stat").write_text(f"{pid} ({name}) " + " ".join(fields))
            result = linux_storage_processes(SimpleNamespace(proc=SimpleNamespace(pid=50)), root / "taomni", root)
            self.assertEqual(result, {1: "100", 2: "200"})

    def test_macos_requires_a_normal_owned_process_exit(self):
        driver = SimpleNamespace(proc=Mock())
        driver.proc.wait.return_value = 0
        session = SimpleNamespace(transport="macOS WKWebView bridge", deadline=None)
        self.assertEqual(wait_for_application_shutdown(driver, session, {})["exit_code"], 0)
        driver.proc.wait.return_value = 9
        with self.assertRaisesRegex(RuntimeError, "exit 9"):
            wait_for_application_shutdown(driver, session, {})

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux process observations")
    def test_storage_shutdown_waits_without_sending_a_signal(self):
        process = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
        timer = threading.Timer(0.2, process.stdin.close)
        timer.start()
        try:
            fields = Path(f"/proc/{process.pid}/stat").read_text().rsplit(")", 1)[1].split()
            session = SimpleNamespace(transport="tauri-driver", deadline=None)
            result = wait_for_application_shutdown(None, session, {process.pid: fields[19]}, timeout=5)
            self.assertGreater(result["duration_sec"], 0.1)
            self.assertEqual(process.wait(timeout=5), 0)
        finally:
            timer.join()
            process.wait(timeout=5)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux process observations")
    def test_unfinished_storage_is_a_failure_and_stays_alive(self):
        process = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
        try:
            fields = Path(f"/proc/{process.pid}/stat").read_text().rsplit(")", 1)[1].split()
            session = SimpleNamespace(transport="tauri-driver", deadline=None)
            with self.assertRaisesRegex(RuntimeError, "did not exit normally"):
                wait_for_application_shutdown(None, session, {process.pid: fields[19]}, timeout=0.03)
            self.assertIsNone(process.poll())
        finally:
            process.stdin.close()
            process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
