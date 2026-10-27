import base64
import socket
from unittest import TestCase
from unittest.mock import patch

from ci_ssh_input_probe import TerminalProbe


class Channel:
    def __init__(self, output):
        self.output = iter(output)
        self.sent = []
        self.resizes = []

    def settimeout(self, _value):
        pass

    def recv(self, _size):
        return next(self.output, b"")

    def sendall(self, data):
        self.sent.append(data)

    def resize_pty(self, **size):
        self.resizes.append(size)


class SshInputProbeTest(TestCase):
    def test_success_records_one_command_focus_and_resize_in_original_order(self):
        channel = Channel([b"UCRT64 ~\r\n$ ", b"\r\nqa-marker\r\n$ "])
        with patch("ci_ssh_input_probe.time.sleep") as pause:
            result = TerminalProbe(channel).run("qa-marker", resize=True, focus=True, delay=0.05)
        self.assertTrue(result["passed"])
        self.assertEqual(channel.sent, [b"\x1b[O", b"\x1b[I", b"echo qa-marker", b"\r"])
        self.assertEqual(channel.resizes, [{"width": 104, "height": 32}])
        pause.assert_called_once_with(0.05)
        self.assertEqual([f["direction"] for f in result["frames"]],
                         ["received", "sent", "resize", "sent", "sent", "sent", "received"])

    def test_lost_first_byte_fails_without_replaying_or_using_echo_as_output(self):
        channel = Channel([b"UCRT64 ~\r\n$ ", b"echo qa-marker\r\nbash: cho: command not found\r\n$ "])
        result = TerminalProbe(channel).run("qa-marker", resize=False, focus=False, delay=0)
        self.assertFalse(result["passed"])
        self.assertEqual(channel.sent, [b"echo qa-marker", b"\r"])
        self.assertEqual(base64.b64decode(result["frames"][-1]["data_base64"]),
                         b"echo qa-marker\r\nbash: cho: command not found\r\n$ ")

    def test_split_cursor_query_receives_exactly_one_answer(self):
        channel = Channel([b"\x1b[", b"6n", b"UCRT64 ~\r\n$ ", b"\r\nqa-marker\r\n"])
        result = TerminalProbe(channel).run("qa-marker", resize=False, focus=False, delay=0)
        self.assertTrue(result["passed"])
        self.assertEqual(channel.sent, [b"\x1b[1;1R", b"echo qa-marker", b"\r"])

    def test_shell_closing_before_prompt_never_receives_a_probe_command(self):
        channel = Channel([b"login failed"])
        result = TerminalProbe(channel).run("qa-marker", resize=True, focus=True, delay=0)
        self.assertFalse(result["ready"])
        self.assertEqual(channel.sent, [])

    def test_receive_timeout_does_not_restart_command(self):
        channel = Channel([b"$ ", b"\r\nqa-marker\r\n"])
        original_recv = channel.recv
        pending = [False]

        def recv(size):
            if not pending[0]:
                pending[0] = True
                raise socket.timeout()
            return original_recv(size)

        channel.recv = recv
        result = TerminalProbe(channel).run("qa-marker", resize=False, focus=False, delay=0)
        self.assertTrue(result["passed"])
        self.assertEqual(channel.sent, [b"echo qa-marker", b"\r"])
