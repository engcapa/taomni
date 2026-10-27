"""The mutable VNC service must not be reset by a concurrent browser case."""
import multiprocessing
import socket
import unittest

from qa_ui_auto.browser_case import fixture_access, run_browser_case


def hold_fixture(payload, entered, release):
    with fixture_access(payload):
        entered.set()
        if not release.wait(10):
            raise RuntimeError("test owner was not released")


def payload(port):
    return {"case": {"id": "VNC-test", "title": "fixture isolation", "tags": [],
                     "covers": [], "modes": ["browser"], "steps": [], "fixtures": ["vnc_required"]},
            "cfg": {"vnc": {"host": "127.0.0.1", "port": port, "control_port": port}}}


class BrowserCaseTests(unittest.TestCase):
    def test_same_service_is_exclusive_until_case_cleanup_finishes(self):
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            config = payload(server.getsockname()[1])
            ctx = multiprocessing.get_context("spawn")
            first, second = ctx.Event(), ctx.Event()
            release_first, release_second = ctx.Event(), ctx.Event()
            processes = [ctx.Process(target=hold_fixture, args=(config, first, release_first)),
                         ctx.Process(target=hold_fixture, args=(config, second, release_second))]
            try:
                processes[0].start()
                self.assertTrue(first.wait(5))
                processes[1].start()
                self.assertFalse(second.wait(0.3), "second case reset the active VNC fixture")
                release_first.set()
                self.assertTrue(second.wait(5))
                release_second.set()
                for process in processes:
                    process.join(5)
                    self.assertEqual(process.exitcode, 0)
            finally:
                release_first.set()
                release_second.set()
                for process in processes:
                    if process.pid:
                        process.join(5)
                        if process.is_alive():
                            process.terminate()
                            process.join(5)

    def test_failure_preserves_original_result_and_releases_fixture(self):
        config = payload(0)
        def fail(_):
            raise ValueError("fixture failed")
        result = run_browser_case(config, fail)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["failure"]["message"], "fixture failed")
        self.assertEqual(result["failure"]["step_index"], 0)
        self.assertEqual(run_browser_case(config, lambda _: {"status": "passed"}), {"status": "passed"})

    def test_other_cases_and_dry_runs_keep_their_existing_path(self):
        for config in [{"case": {"fixtures": []}}, {"case": {"fixtures": ["vnc_required"]}, "dry_run": True}]:
            with fixture_access(config):
                pass


if __name__ == "__main__":
    unittest.main()
