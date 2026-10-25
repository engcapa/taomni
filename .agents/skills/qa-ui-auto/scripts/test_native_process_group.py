import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from native_process_group import stop_owned_process_group, wait_for_driver_ports


class NativePortReleaseTest(unittest.TestCase):
    def test_closed_loopback_can_take_longer_than_a_short_probe_to_refuse(self):
        def connect(address, timeout):
            if timeout < 1:
                raise TimeoutError("Windows loopback refusal is still pending")
            raise ConnectionRefusedError("Windows loopback has no listener")
        with patch("native_process_group.socket.create_connection", side_effect=connect):
            wait_for_driver_ports("127.0.0.1", (4444, 4445))

    def test_restart_waits_for_a_late_adapter_socket_close(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        release = threading.Timer(0.08, listener.close)
        release.start()
        try:
            wait_for_driver_ports("127.0.0.1", (port,), timeout=2)
            with socket.socket() as probe:
                self.assertNotEqual(probe.connect_ex(("127.0.0.1", port)), 0)
        finally:
            release.join()
            listener.close()

    def test_an_unreleased_listener_fails_without_terminating_it(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            with self.assertRaisesRegex(RuntimeError, str(port)):
                wait_for_driver_ports("127.0.0.1", (port,), timeout=0.03)
            self.assertGreater(listener.fileno(), 0)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux driver process groups")
class NativeProcessGroupTest(unittest.TestCase):
    def test_releases_adapter_port_after_launcher_exits_without_touching_other_groups(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as other:
            other.bind(("127.0.0.1", 0))
            other.listen()
            port_file = Path(directory) / "adapter-port"
            child = (
                "import socket,sys,time; s=socket.socket(); s.bind(('127.0.0.1',0)); "
                "s.listen(); open(sys.argv[1],'w').write(str(s.getsockname()[1])); time.sleep(60)"
            )
            launcher = (
                "import subprocess,sys; "
                "subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]], "
                "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)"
            )
            proc = subprocess.Popen([sys.executable, "-c", launcher, child, str(port_file)], start_new_session=True)
            try:
                deadline = time.monotonic() + 5
                while not port_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(port_file.exists())
                port = int(port_file.read_text())
                proc.wait(timeout=5)
                stop_owned_process_group(proc)
                with socket.socket() as reopened:
                    deadline = time.monotonic() + 5
                    while True:
                        try:
                            reopened.bind(("127.0.0.1", port))
                            break
                        except OSError:
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(0.02)
                self.assertGreater(other.fileno(), 0)
                self.assertEqual(other.getsockname()[0], "127.0.0.1")
            finally:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
