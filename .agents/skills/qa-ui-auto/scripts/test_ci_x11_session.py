from pathlib import Path
import subprocess
import tempfile
import threading
from unittest import TestCase
from unittest.mock import Mock, patch

from ci_x11_session import observe_window_tree, publish_window_tree


class X11WindowObserverTest(TestCase):
    argv = ["/opt/X11/bin/xwininfo", "-root", "-tree"]
    tree = 'Root window: 1 child\n  "TaomniQADesktop"\n'

    def observe(self, samples):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "x11-window-tree.txt"
            stop = Mock()
            stop.wait.side_effect = [False] * len(samples) + [True]
            with patch("ci_x11_session.subprocess.run", side_effect=samples) as run:
                observe_window_tree(self.argv, report, stop)
            self.assertFalse(report.with_suffix(".tmp").exists())
            for call in run.call_args_list:
                self.assertEqual(call.args[0], self.argv)
                self.assertEqual(call.kwargs, dict(capture_output=True, text=True, timeout=5))
            return report.read_text(encoding="utf-8")

    def success(self):
        return subprocess.CompletedProcess(self.argv, 0, self.tree, "")

    def test_command_timeout_does_not_kill_future_real_window_observations(self):
        self.assertEqual(self.observe([
            subprocess.TimeoutExpired(self.argv, 5), self.success(),
        ]), self.tree)

    def test_spawn_error_does_not_kill_future_observations(self):
        self.assertEqual(self.observe([OSError("temporarily unavailable"), self.success()]), self.tree)

    def test_failed_command_recovers_without_publishing_its_stdout_as_evidence(self):
        failure = subprocess.CompletedProcess(self.argv, 1, "invalid window tree", "display unavailable")
        self.assertEqual(self.observe([failure, self.success()]), self.tree)

    def test_later_timeout_invalidates_a_previous_pass_instead_of_leaving_stale_evidence(self):
        observed = self.observe([self.success(), subprocess.TimeoutExpired(self.argv, 5)])
        self.assertIn("observation unavailable", observed)
        self.assertIn("timed out after 5 seconds", observed)
        self.assertNotIn("TaomniQADesktop", observed)

    def test_later_command_failure_publishes_an_actionable_error(self):
        failure = subprocess.CompletedProcess(self.argv, 1, self.tree, "cannot open display")
        observed = self.observe([self.success(), failure])
        self.assertIn("exit 1", observed)
        self.assertIn("cannot open display", observed)
        self.assertNotIn("TaomniQADesktop", observed)

    def test_stopping_does_not_launch_another_command_or_publish_a_fake_sample(self):
        with tempfile.TemporaryDirectory() as directory, patch("ci_x11_session.subprocess.run") as run:
            report = Path(directory) / "x11-window-tree.txt"
            stop = Mock()
            stop.wait.return_value = True
            observe_window_tree(self.argv, report, stop)
            run.assert_not_called()
            self.assertFalse(report.exists())


class X11WindowPublicationTest(TestCase):
    def test_reader_sharing_violation_is_retried_before_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "x11-window-tree.txt"
            report.write_text("old sample", encoding="utf-8")
            original = Path.replace
            attempts = 0

            def replace(path, target):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise PermissionError("reader still has the Windows file open")
                return original(path, target)

            with patch.object(Path, "replace", replace):
                publish_window_tree(report, "fresh sample", threading.Event())
            self.assertEqual(attempts, 2)
            self.assertEqual(report.read_text(encoding="utf-8"), "fresh sample")
            self.assertFalse(report.with_suffix(".tmp").exists())

    def test_shutdown_interrupts_a_locked_destination_and_removes_the_pending_file(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "x11-window-tree.txt"
            stop = threading.Event()
            stop.set()
            with patch.object(Path, "replace", side_effect=PermissionError("reader open")) as replace:
                publish_window_tree(report, "fresh sample", stop)
            replace.assert_called_once()
            self.assertFalse(report.exists())
            self.assertFalse(report.with_suffix(".tmp").exists())

    def test_actual_reader_can_close_while_the_observer_waits(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "x11-window-tree.txt"
            report.write_text("old sample", encoding="utf-8")
            stop = threading.Event()
            started = threading.Event()
            errors = []

            def publish():
                started.set()
                try:
                    publish_window_tree(report, "fresh sample", stop)
                except BaseException as error:
                    errors.append(error)

            with report.open("r", encoding="utf-8") as reader:
                worker = threading.Thread(target=publish, daemon=True)
                worker.start()
                self.assertTrue(started.wait(2))
                self.assertEqual(reader.read(), "old sample")
            worker.join(2)
            stop.set()
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(report.read_text(encoding="utf-8"), "fresh sample")
