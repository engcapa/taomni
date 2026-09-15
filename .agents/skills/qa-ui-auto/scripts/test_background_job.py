"""background_job keeps resident commands out of the caller's process tree."""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPTS_DIR = Path(__file__).resolve().parent
BACKGROUND_JOB = SCRIPTS_DIR / "background_job.py"


def run_cli(*args: str, timeout: float = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(BACKGROUND_JOB), *args],
        capture_output=True, text=True, timeout=timeout,
    )


def state_for(log: Path) -> Path:
    return Path(str(log) + ".job.json")


@contextlib.contextmanager
def cleanup_directory():
    """TemporaryDirectory retries rmtree recursively on Windows lock errors."""
    path = Path(tempfile.mkdtemp(prefix="qa-background-job-"))
    try:
        yield path
    finally:
        deadline = time.time() + 10
        while True:
            try:
                shutil.rmtree(path)
                break
            except OSError:
                if time.time() >= deadline:
                    shutil.rmtree(path, ignore_errors=True)
                    break
                time.sleep(0.2)


def wait_for_log(log: Path, needle: str, timeout: float = 15) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
        if needle in text:
            return text
        time.sleep(0.2)
    return log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""


def wait_for_dead(state: Path, timeout: float = 10) -> str:
    deadline = time.time() + timeout
    status = ""
    while time.time() < deadline:
        status = run_cli("status", "--state", str(state)).stdout
        if status.startswith("dead"):
            return status
        time.sleep(0.2)
    return status


def wait_for_pid_line(log: Path, timeout: float = 15) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = log.read_text(encoding="utf-8", errors="replace").strip() if log.exists() else ""
        if text:
            try:
                return int(text.split()[0])
            except ValueError:
                pass
        time.sleep(0.2)
    raise AssertionError(f"no pid line appeared in {log}")


class BackgroundJobTest(unittest.TestCase):
    def test_start_returns_while_resident_command_keeps_running(self):
        """A 60s child must not block start: this is the anti-hang contract."""
        with cleanup_directory() as root:
            log = root / "resident.log"
            started = time.monotonic()
            result = run_cli(
                "start", "--name", "resident", "--log", str(log), "--cwd", str(root),
                "--", sys.executable, "-u", "-c",
                "import time; print('up', flush=True); time.sleep(60)",
            )
            elapsed = time.monotonic() - started
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertLess(elapsed, 20)
            state = state_for(log)
            self.assertTrue(json.loads(state.read_text(encoding="utf-8"))["pid"])
            try:
                self.assertIn("alive", run_cli("status", "--state", str(state)).stdout)
                self.assertIn("up", wait_for_log(log, "up"))
            finally:
                run_cli("stop", "--state", str(state))
            self.assertTrue(wait_for_dead(state).startswith("dead"))

    def test_wait_propagates_the_child_exit_code(self):
        with cleanup_directory() as root:
            log = root / "exit3.log"
            result = run_cli(
                "start", "--name", "exit3", "--log", str(log), "--cwd", str(root),
                "--", sys.executable, "-u", "-c",
                "print('done', flush=True); raise SystemExit(3)",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            waited = run_cli("wait", "--state", str(state_for(log)), "--timeout", "30",
                             "--poll", "0.2")
            self.assertEqual(waited.returncode, 3, waited.stdout + waited.stderr)
            self.assertIn("EXITCODE=3", log.read_text(encoding="utf-8"))

    def test_explicit_env_reaches_the_detached_child(self):
        with cleanup_directory() as root:
            log = root / "env.log"
            script = "import os; print(os.environ['QA_BG_TEST_MARK'], flush=True)"
            result = run_cli(
                "start", "--name", "env", "--log", str(log), "--cwd", str(root),
                "--env", "QA_BG_TEST_MARK=detached-value",
                "--", sys.executable, "-u", "-c", script,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            waited = run_cli("wait", "--state", str(state_for(log)), "--timeout", "30",
                             "--poll", "0.2")
            self.assertEqual(waited.returncode, 0, waited.stdout + waited.stderr)
            self.assertIn("detached-value", log.read_text(encoding="utf-8"))

    def test_wait_reports_timeout_for_a_live_job(self):
        with cleanup_directory() as root:
            log = root / "hang.log"
            result = run_cli(
                "start", "--name", "hang", "--log", str(log), "--cwd", str(root),
                "--", sys.executable, "-u", "-c", "import time; time.sleep(60)",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            try:
                waited = run_cli("wait", "--state", str(state_for(log)), "--timeout", "1",
                                 "--poll", "0.2")
                self.assertEqual(waited.returncode, 2, waited.stdout + waited.stderr)
            finally:
                run_cli("stop", "--state", str(state_for(log)))
            self.assertTrue(wait_for_dead(state_for(log)).startswith("dead"))

    def test_stop_terminates_the_whole_job_tree(self):
        with cleanup_directory() as root:
            log = root / "tree.log"
            child = (
                "import subprocess, sys, time;"
                f"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']);"
                f"print(p.pid, flush=True); time.sleep(60)"
            )
            result = run_cli(
                "start", "--name", "tree", "--log", str(log), "--cwd", str(root),
                "--", sys.executable, "-u", "-c", child,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            grandchild = wait_for_pid_line(log)
            stop = run_cli("stop", "--state", str(state_for(log)), "--grace", "2")
            self.assertEqual(stop.returncode, 0, stop.stdout + stop.stderr)
            deadline = time.time() + 10
            while time.time() < deadline:
                if not _alive(grandchild):
                    return
                time.sleep(0.2)
            self.fail(f"grandchild {grandchild} survived stop")

    def test_start_rejects_missing_command(self):
        result = run_cli("start", "--name", "empty", "--log", "nowhere.log")
        self.assertNotEqual(result.returncode, 0)


def _alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) \
                and code.value == 259
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


if __name__ == "__main__":
    unittest.main()
