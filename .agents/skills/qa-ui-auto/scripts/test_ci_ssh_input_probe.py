import base64
import socket
from unittest import TestCase
from unittest.mock import Mock, patch

from ci_ssh_input_probe import TerminalProbe, open_shell


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
    def test_console_opens_an_unmodified_interactive_shell(self):
        client = Mock()
        self.assertIs(open_shell(client, "console"), client.invoke_shell.return_value)
        client.invoke_shell.assert_called_once_with(term="xterm-256color", width=171, height=32)
        client.get_transport.assert_not_called()

    def test_posix_wrapper_gets_a_pty_and_passes_conversion_option_through_env(self):
        client = Mock()
        channel = client.get_transport.return_value.open_session.return_value
        self.assertIs(open_shell(client, "msys-script"), channel)
        channel.get_pty.assert_called_once_with(term="xterm-256color", width=171, height=32)
        command = channel.exec_command.call_args.args[0]
        self.assertTrue(command.startswith("exec env MSYS2_ARG_CONV_EXCL='*' /c/msys64/usr/bin/script.exe "))
        self.assertIn("-c '/usr/bin/bash --noprofile --norc -i' /dev/null", command)
        client.invoke_shell.assert_not_called()

    def test_msys_console_uses_the_same_requested_geometry_without_a_script_wrapper(self):
        client = Mock()
        channel = client.get_transport.return_value.open_session.return_value
        self.assertIs(open_shell(client, "msys-console"), channel)
        channel.get_pty.assert_called_once_with(term="xterm-256color", width=171, height=32)
        channel.exec_command.assert_called_once_with(
            "exec env MSYS2_ARG_CONV_EXCL='*' /c/msys64/usr/bin/bash.exe --noprofile --norc -i")
        channel.set_combine_stderr.assert_called_once_with(True)

    def test_win32_protocol_has_one_key_down_and_key_up_for_each_character(self):
        channel = Channel([b"$ ", b"\r\nqa-marker\r\n"])
        result = TerminalProbe(channel).run("qa-marker", resize=True, focus=False, delay=0, protocol="win32")
        self.assertTrue(result["passed"])
        self.assertEqual(channel.sent[:2], [b"\x1b[0;0;101;1;0;1_", b"\x1b[0;0;101;0;0;1_"])
        self.assertEqual(len(channel.sent), len("echo qa-marker\r") * 2)

    def test_paste_protocol_preserves_enabled_bracketed_paste_boundaries(self):
        channel = Channel([b"$ ", b"\r\nqa-marker\r\n"])
        result = TerminalProbe(channel).run("qa-marker", resize=True, focus=False, delay=0, protocol="paste")
        self.assertTrue(result["passed"])
        self.assertEqual(channel.sent, [b"\x1b[200~echo qa-marker\x1b[201~", b"\r"])

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
