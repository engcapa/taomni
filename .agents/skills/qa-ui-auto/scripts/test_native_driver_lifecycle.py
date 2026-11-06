"""A failed explicit restart must not poison the next Linux case's driver."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from native_driver_lifecycle import driver_start_environment
from tauri_webdriver import TauriDriverProcess


class NativeDriverLifecycleTest(unittest.TestCase):
    def test_fixture_path_and_restoration_restart_the_driver_parent(self):
        with TemporaryDirectory() as directory:
            driver = TauriDriverProcess({}, Path(directory))
            for original, updated in [("/system", "/fixture:/system"), ("/fixture:/system", "/system")]:
                driver.proc = Mock()
                driver.proc.poll.return_value = None
                with patch.dict("os.environ", {"PATH": original}):
                    self.assertEqual(driver_start_environment(driver)["PATH"], original)
                def stopped():
                    driver.proc = None
                with patch.dict("os.environ", {"PATH": updated}), \
                        patch("tauri_webdriver.platform.system", return_value="Linux"), \
                        patch.object(driver, "stop", side_effect=stopped) as stop, \
                        patch("native_driver_lifecycle.wait_for_driver_ports") as ports, \
                        patch.object(driver, "start") as start:
                    driver.ensure_running()
                stop.assert_called_once()
                ports.assert_called_once()
                start.assert_called_once()
    def test_windows_reused_driver_checks_adapter_integrity_before_app_launch(self):
        with TemporaryDirectory() as directory:
            driver = TauriDriverProcess({}, Path(directory))
            driver.proc = Mock(pid=17)
            driver.proc.poll.return_value = None
            with patch("tauri_webdriver.platform.system", return_value="Windows"), \
                 patch("tauri_webdriver._tcp_ok", return_value=True), \
                 patch("native_windows_integrity.ensure_medium_driver_tree") as inspect:
                driver.ensure_running()
            inspect.assert_called_once_with(17)

    def test_windows_restarted_driver_checks_new_owned_tree(self):
        with TemporaryDirectory() as directory:
            driver = TauriDriverProcess({}, Path(directory))
            def start():
                driver.proc = Mock(pid=18)
            with patch("tauri_webdriver.platform.system", return_value="Windows"), \
                 patch("tauri_webdriver._tcp_ok", return_value=False), \
                 patch.object(driver, "start", side_effect=start), \
                 patch("native_windows_integrity.ensure_medium_driver_tree") as inspect:
                driver.ensure_running()
            inspect.assert_called_once_with(18)

    def test_linux_reuses_its_running_owned_driver(self):
        with TemporaryDirectory() as directory:
            driver = TauriDriverProcess({}, Path(directory))
            driver.proc = Mock()
            driver.proc.poll.return_value = None
            with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                    patch("native_driver_lifecycle.wait_for_driver_ports") as ports, \
                    patch.object(driver, "start") as start:
                driver.ensure_running()
            ports.assert_not_called()
            start.assert_not_called()

    def test_linux_stopped_driver_releases_both_ports_before_the_next_case(self):
        with TemporaryDirectory() as directory:
            driver = TauriDriverProcess({}, Path(directory))
            events = []
            with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                    patch("native_driver_lifecycle.wait_for_driver_ports", side_effect=lambda *args: events.append("ports-free")) as ports, \
                    patch.object(driver, "start", side_effect=lambda: events.append("start-owner")):
                driver.ensure_running()
            ports.assert_called_once_with(driver.host, (driver.port, driver.native_port))
            self.assertEqual(events, ["ports-free", "start-owner"])

    def test_linux_exited_driver_is_released_before_starting_another_owner(self):
        with TemporaryDirectory() as directory:
            driver = TauriDriverProcess({}, Path(directory))
            driver.proc = Mock()
            driver.proc.poll.return_value = 1
            events = []
            with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                    patch.object(driver, "stop", side_effect=lambda: events.append("stop-owner")), \
                    patch("native_driver_lifecycle.wait_for_driver_ports", side_effect=lambda *args: events.append("ports-free")), \
                    patch.object(driver, "start", side_effect=lambda: events.append("start-owner")):
                driver.ensure_running()
            self.assertEqual(events, ["stop-owner", "ports-free", "start-owner"])

    def test_linux_unreleased_ports_remain_a_failure_without_starting_a_second_owner(self):
        with TemporaryDirectory() as directory:
            driver = TauriDriverProcess({}, Path(directory))
            with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                    patch("native_driver_lifecycle.wait_for_driver_ports", side_effect=RuntimeError("still listening")), \
                    patch.object(driver, "start") as start:
                with self.assertRaisesRegex(RuntimeError, "still listening"):
                    driver.ensure_running()
            start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
