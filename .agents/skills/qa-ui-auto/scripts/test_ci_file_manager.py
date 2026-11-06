"""Job-owned desktop readiness, directory association and cleanup contracts."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from ci_desktop import Desktop
from ci_file_manager import HANDLER, SERVICE, prepare_file_manager


class FileManagerTests(unittest.TestCase):
    def test_ready_manager_owns_its_bus_service_and_private_directory_association(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ), \
                patch("ci_file_manager.subprocess.run") as run:
            root = Path(temp) / "manager"
            start = Mock(return_value=Mock(pid=42))
            run.side_effect = [subprocess.CompletedProcess([], 0, "(uint32 42,)\n"),
                               subprocess.CompletedProcess([], 0, HANDLER + "\n")]
            def wait(process, probe, description):
                self.assertIs(process, start.return_value)
                self.assertTrue(probe())
            result = prepare_file_manager(root, start, wait)
            self.assertEqual(result["pid"], 42)
            self.assertTrue(result["ready"])
            self.assertEqual(start.call_args.args[0], ["pcmanfm-qt", "--daemon-mode"])
            environment = start.call_args.kwargs["env"]
            self.assertEqual(environment["QT_QPA_PLATFORM"], "xcb")
            for name in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"):
                self.assertTrue(Path(environment[name]).is_relative_to(root))
            mime = root / "config/mimeapps.list"
            self.assertEqual(mime.read_text(), "[Default Applications]\ninode/directory=" + HANDLER + ";\n")
            self.assertNotIn("http", mime.read_text())
            self.assertEqual(run.call_args_list[0].args[0][-1], SERVICE)
            probe_environment = run.call_args_list[-1].kwargs["env"]
            self.assertNotEqual(probe_environment["XDG_CONFIG_HOME"], environment["XDG_CONFIG_HOME"])
            self.assertTrue(probe_environment["XDG_CONFIG_DIRS"].startswith(str(root / "config") + os.pathsep))

    def test_manager_from_another_process_does_not_satisfy_readiness(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ), \
                patch("ci_file_manager.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "(uint32 99,)\n")):
            def wait(process, probe, description):
                self.assertFalse(probe())
                raise RuntimeError("job-owned file manager did not become ready")
            with self.assertRaisesRegex(RuntimeError, "did not become ready"):
                prepare_file_manager(Path(temp) / "manager", Mock(return_value=Mock(pid=42)), wait)

    def test_missing_directory_association_fails_preflight(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ), \
                patch("ci_file_manager.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "other.desktop\n")):
            with self.assertRaisesRegex(RuntimeError, "directory association"):
                prepare_file_manager(Path(temp) / "manager", Mock(return_value=Mock(pid=42)), Mock())

    def test_refuses_existing_manager_directory_without_overwriting_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            marker = root / "personal.txt"
            marker.write_text("unchanged")
            start = Mock()
            with self.assertRaises(FileExistsError):
                prepare_file_manager(root, start, Mock())
            self.assertEqual(marker.read_text(), "unchanged")
            start.assert_not_called()

    def test_desktop_restores_xdg_fallback_on_exit(self):
        for original in (None, "/before"):
            with self.subTest(original=original), tempfile.TemporaryDirectory() as temp, patch.dict(os.environ):
                os.environ.pop("XDG_CONFIG_DIRS", None)
                if original is not None:
                    os.environ["XDG_CONFIG_DIRS"] = original
                desktop = Desktop(Path(temp), [])
                os.environ["XDG_CONFIG_DIRS"] = "/owned:/before"
                desktop.__exit__(None, None, None)
                self.assertEqual(os.environ.get("XDG_CONFIG_DIRS"), original)

    def test_openbox_starts_manager_while_lxqt_keeps_its_existing_service(self):
        for profile, version, needs_manager in (("ubuntu-24.04-xvfb", "24.04", True),
                                                ("ubuntu-22.04-x11", "22.04", False)):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as temp, \
                    patch.dict(os.environ, {"DISPLAY": ":99", "DBUS_SESSION_BUS_ADDRESS": "qa-bus"}), \
                    patch("ci_desktop.platform.system", return_value="Linux"), \
                    patch("ci_desktop.platform.machine", return_value="x86_64"), \
                    patch("ci_desktop.platform.freedesktop_os_release", return_value={"ID": "ubuntu", "VERSION_ID": version}), \
                    patch("ci_desktop.subprocess.check_output", side_effect=["XTEST", "window id # 1"]), \
                    patch("ci_desktop.subprocess.run"), patch("ci_desktop.time.sleep"), \
                    patch.object(Desktop, "start") as start, \
                    patch("ci_file_manager.prepare_file_manager", return_value={"ready": True}) as manager:
                start.return_value.poll.return_value = None
                with Desktop(Path(temp), ["display"], profile) as desktop:
                    self.assertEqual(manager.call_count, int(needs_manager))
                    if needs_manager:
                        self.assertTrue(desktop.facts["file_manager"]["ready"])

    @unittest.skipUnless(os.name == "posix", "bash provisioning is POSIX-only")
    def test_setup_installs_file_manager_for_default_run_not_build(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            script = root / "ci_linux_setup.sh"
            script.write_text(Path(__file__).with_name("ci_linux_setup.sh").read_text())
            (root / "ci_linux_apt.sh").write_text(
                "prepare_apt_mirrors() { :; }\nupdate_package_index() { :; }\n"
                'install_packages() { printf "%s\\n" "$*" >> "$QA_PACKAGE_LOG"; }\n')
            for operation in ("build", "run"):
                log = root / (operation + ".log")
                result = subprocess.run(["bash", str(script)], capture_output=True, text=True,
                    env={**os.environ, "QA_OPERATION": operation, "QA_LINUX_PROFILE": "ubuntu-24.04-xvfb",
                         "QA_PACKAGE_LOG": str(log)})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual("pcmanfm-qt" in log.read_text(), operation == "run")


if __name__ == "__main__":
    unittest.main()
