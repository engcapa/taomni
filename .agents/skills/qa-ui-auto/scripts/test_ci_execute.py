import json
from contextlib import contextmanager, ExitStack
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ci_execute import _classify_runner_result, _prepare_runtime


class ExecuteRuntimeTests(unittest.TestCase):
    def test_display_services_use_the_started_desktop_until_their_cleanup_finishes(self):
        for profile in ("ubuntu-22.04-vnc", "ubuntu-26.04-wayland"):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory:
                events = []

                @contextmanager
                def desktop(*args):
                    with patch.dict(os.environ, {"DISPLAY": ":81"}):
                        events.append("desktop-start")
                        try:
                            yield "owned-desktop"
                        finally:
                            events.append("desktop-stop")

                @contextmanager
                def services(root, capabilities, config):
                    self.assertEqual(os.environ["DISPLAY"], ":81")
                    events.append("x11-start")
                    config["ssh_features"] = {"desktop": os.environ["DISPLAY"]}
                    try:
                        yield
                    finally:
                        self.assertEqual(os.environ["DISPLAY"], ":81")
                        events.append("x11-stop")

                entry = {"mode": "native", "capabilities": ["ssh_features", "x11_session"],
                         "linux_profile": profile}
                config = {}
                with patch.dict(os.environ), patch("ci_desktop.Desktop", desktop), \
                        patch("ci_services.Services", services):
                    os.environ.pop("DISPLAY", None)
                    with self.assertRaisesRegex(RuntimeError, "case failure"), ExitStack() as stack:
                        result = _prepare_runtime(stack, entry, Path(directory), config)
                        self.assertEqual(result, "owned-desktop")
                        self.assertEqual(config["ssh_features"]["desktop"], ":81")
                        raise RuntimeError("case failure")
                    self.assertNotIn("DISPLAY", os.environ)
                self.assertEqual(events, ["desktop-start", "x11-start", "x11-stop", "desktop-stop"])

    def test_browser_services_do_not_start_a_native_desktop(self):
        for capability in ("ssh", "ssh_posix"):
            with self.subTest(capability=capability), tempfile.TemporaryDirectory() as directory, ExitStack() as stack, \
                    patch("ci_desktop.Desktop") as desktop, patch("ci_services.Services") as services:
                self.assertIsNone(_prepare_runtime(stack, {"mode": "browser", "capabilities": [capability]},
                                                   Path(directory), {}))
                desktop.assert_not_called()
                services.return_value.__enter__.assert_called_once()


class ExecuteOutcomeTests(unittest.TestCase):
    def write_summary(self, root: Path, *, identity_stable: bool = True) -> None:
        run = root / "run-example"
        run.mkdir(parents=True)
        (run / "summary.json").write_text(json.dumps({
            "dry_run": False,
            "identity_stable": identity_stable,
            "cases": [{"id": "TC-example", "status": "failed"}],
            "totals": {"total": 1, "passed": 0, "failed": 1, "skipped": 0},
        }), encoding="utf-8")

    def test_complete_failure_report_is_a_successful_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_summary(root)

            result = _classify_runner_result(root, runner_exit_code=1)

            self.assertEqual(result["exit_code"], 0)
            self.assertEqual(result["runner_exit_code"], 1)
            self.assertEqual(result["case_result_exit_code"], 1)
            self.assertNotIn("error", result)

    def test_missing_report_is_an_execution_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            result = _classify_runner_result(Path(directory), runner_exit_code=1)

            self.assertEqual(result["exit_code"], 1)
            self.assertIn("did not produce summary.json", result["error"])

    def test_unstable_identity_is_an_execution_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_summary(root, identity_stable=False)

            result = _classify_runner_result(root, runner_exit_code=1)

            self.assertEqual(result["exit_code"], 1)
            self.assertIn("identity is unstable", result["error"])


if __name__ == "__main__":
    unittest.main()
