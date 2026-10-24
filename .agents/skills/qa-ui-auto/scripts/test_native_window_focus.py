"""Native sessions keep their own profile when a peer harness changes the environment."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from tauri_webdriver import NativeSession


class NativeWindowFocusTest(unittest.TestCase):
    def test_primary_and_peer_activation_retain_their_own_data_home(self):
        binary = Path("/tmp/taomni-qa")
        with patch.dict(os.environ, {"XDG_DATA_HOME": "/qa/primary"}):
            primary = NativeSession("http://driver.invalid", binary)
            with patch.dict(os.environ, {"XDG_DATA_HOME": "/qa/peer", "QA_WAYLAND_INPUT_SOCKET": "/qa/input.sock"}), \
                    patch("native_window_focus.socket.AF_UNIX", 1, create=True), \
                    patch("native_window_focus.socket.socket") as factory:
                peer = NativeSession("http://peer.invalid", binary)
                connection = factory.return_value.__enter__.return_value
                connection.recv.return_value = b'{"ok":true}\n'
                for session, expected in ((primary, "/qa/primary"), (peer, "/qa/peer")):
                    session.session_id = "session-1"
                    session.request = Mock(side_effect=[{"title": "QA detached SFTP"}, "window-qa", None])
                    session.execute = Mock(return_value=True)
                    session.activate_wayland_window()
                    request = json.loads(connection.sendall.call_args.args[0])
                    self.assertEqual(request["data_home"], expected)
                    self.assertEqual(request["application"], str(binary.resolve()))
                    self.assertEqual(request["command"], "activate")
                    self.assertEqual(request["title"], "QA detached SFTP")
                    title_request = session.request.call_args_list[0].args
                    self.assertEqual(title_request[:2], ("POST", "/session/session-1/execute/async"))
                    self.assertIn("metadata.currentWindow.label", title_request[2]["script"])
                    session.execute.assert_called_once_with("return document.hasFocus();")

    def test_missing_native_title_does_not_activate_an_arbitrary_window(self):
        session = NativeSession("http://driver.invalid", Path("/tmp/qa"))
        session.session_id = "session-1"
        session.request = Mock(return_value={"error": "not allowed"})
        with patch.dict(os.environ, {"QA_WAYLAND_INPUT_SOCKET": "/qa/input.sock"}), \
                patch("native_window_focus.socket.socket") as factory:
            with self.assertRaisesRegex(RuntimeError, "native window title"):
                session.activate_wayland_window()
        factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
