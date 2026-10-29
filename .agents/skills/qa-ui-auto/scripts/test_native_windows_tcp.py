"""Contract for the OS listener observation used by Windows application restart."""
import ctypes
import socket
import struct
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import native_windows_tcp as tcp


class WindowsTcpTableTest(unittest.TestCase):
    def test_reads_both_address_families_and_keeps_only_requested_listener_ports(self):
        ipv4 = struct.pack("=I", 2) + b"".join(
            struct.pack("=I4sIIII", 2, socket.inet_pton(socket.AF_INET, "127.0.0.1"),
                        socket.htons(port), 0, 0, pid)
            for port, pid in [(4444, 42), (8080, 99)]
        )
        ipv6 = struct.pack("=I", 1) + struct.pack(
            "=16sII16sIIII", socket.inet_pton(socket.AF_INET6, "fe80::1"), 3,
            socket.htons(4445), bytes(16), 0, 0, 2, 43,
        )
        with patch.object(tcp, "_read_table", side_effect=[ipv4, ipv6]) as read, \
                patch("subprocess.run") as subprocess_run:
            self.assertEqual(tcp.windows_listeners((4444, 4445)), [
                {"LocalAddress": "127.0.0.1", "LocalPort": 4444, "OwningProcess": 42},
                {"LocalAddress": "fe80::1%3", "LocalPort": 4445, "OwningProcess": 43},
            ])
        self.assertEqual([call.args[0] for call in read.call_args_list], [socket.AF_INET, socket.AF_INET6])
        subprocess_run.assert_not_called()

    def test_empty_os_tables_establish_no_listeners(self):
        with patch.object(tcp, "_read_table", return_value=struct.pack("=I", 0)):
            self.assertEqual(tcp.windows_listeners((4444,)), [])

    def test_invalid_listener_state_or_truncated_rows_cannot_establish_free_ports(self):
        invalid = struct.pack("=IIIIIII", 1, 5, 0, 0, 0, 0, 42)
        for data in [b"", b"\0", struct.pack("=I", 1), invalid]:
            with self.subTest(data=data), self.assertRaises(RuntimeError):
                tcp._decode_table(data, socket.AF_INET, (4444,))

    def test_reallocates_if_the_os_table_grows_between_observations(self):
        data = struct.pack("=IIIIIII", 1, 2, 0, socket.htons(4444), 0, 0, 42)
        def query(buffer, size_pointer, ordered, family, table_class, reserved):
            size = ctypes.cast(size_pointer, ctypes.POINTER(tcp._DWORD))
            self.assertEqual((family, table_class, reserved), (socket.AF_INET, 3, 0))
            if buffer is None:
                size.contents.value = 4
                return 122
            if len(buffer) < len(data):
                size.contents.value = len(data)
                return 122
            ctypes.memmove(buffer, data, len(data))
            size.contents.value = len(data)
            return 0
        get_table = Mock(side_effect=query)
        with patch.object(ctypes, "WinDLL", return_value=SimpleNamespace(GetExtendedTcpTable=get_table), create=True):
            self.assertEqual(tcp._read_table(socket.AF_INET), data)
        self.assertEqual(get_table.call_count, 3)

    def test_os_errors_cannot_mean_empty_tables(self):
        get_table = Mock(return_value=5)
        with patch.object(ctypes, "WinDLL", return_value=SimpleNamespace(GetExtendedTcpTable=get_table), create=True):
            with self.assertRaisesRegex(OSError, "GetExtendedTcpTable"):
                tcp._read_table(socket.AF_INET)


if __name__ == "__main__":
    unittest.main()
